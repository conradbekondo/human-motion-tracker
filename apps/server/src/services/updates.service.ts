import { Invite, Notification, Update } from '@chattr/domain';
import { InviteDto } from "@chattr/dto";
import { ICreateRoomInviteRequest, IUpdateInviteRequest, InviteInfo } from "@chattr/interfaces";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { instanceToPlain, plainToInstance } from "class-transformer";
import { isMongoId } from "class-validator";
import EventEmitter from "events";
import { ClientSession, FilterQuery, HydratedDocument, Model, Types, UpdateQuery } from "mongoose";
import { filter, fromEvent, map } from "rxjs";
import { Events } from "../events";
import { generateRandomToken } from "../util";
import { EventEmitter2 } from '@nestjs/event-emitter';

type MessageEvent<T = Notification> = {
    event: string,
    data: T;
}

export type ICreateNotificationRequest = {
    to: string | Types.ObjectId;
    body: string;
    sender: string | Types.ObjectId;
    image?: string;
    title: string;
    data?: Record<string, unknown>;
}

export type InvitationEventData = { roomId: string, userId: string, inviteId: string, targeted: boolean };

@Injectable()
export class UpdatesService {
    private readonly logger = new Logger(UpdatesService.name);
    private readonly notificationModel: Model<Notification>;
    private readonly inviteModel: Model<Invite>;
    constructor(
        @InjectModel(Update.name) private updatesModel: Model<Update>,
        private readonly eventEmitter: EventEmitter2
    ) {
        this.notificationModel = updatesModel.discriminators[Notification.name];
        this.inviteModel = updatesModel.discriminators[Invite.name];
    }

    async getInvitationInfo(code: string) {
        const now = new Date();
        const results = await this.inviteModel.aggregate<InviteInfo>([
            {
                $match: {
                    type: Invite.name,
                    code,
                    expiresAt: { $gt: now }
                }
            },
            {
                $lookup: {
                    from: 'rooms',
                    localField: 'room',
                    foreignField: '_id',
                    as: 'room'
                }
            },
            {
                $lookup: {
                    from: 'roommemberships',
                    localField: 'room.members',
                    foreignField: '_id',
                    as: 'connectedMembers',
                    pipeline: [
                        {
                            $match: {
                                isBanned: { $ne: true },
                                pending: { $ne: true },
                                activeSession: { $ne: null }
                            }
                        },
                        {
                            $lookup: {
                                from: 'users',
                                localField: 'userId',
                                foreignField: '_id',
                                as: 'userAccount'
                            }
                        },
                        {
                            $unwind: {
                                path: '$userAccount'
                            }
                        },
                        {
                            $project: {
                                displayName: '$userAccount.name',
                                _id: 0,
                                avatar: '$userAccount.avatar'
                            }
                        }
                    ]
                }
            },
            {
                $lookup: {
                    from: 'roommemberships',
                    localField: 'createdBy',
                    foreignField: '_id',
                    as: 'createdBy',
                    pipeline: [
                        {
                            $lookup: {
                                from: 'users',
                                localField: 'userId',
                                foreignField: '_id',
                                as: 'userAccount'
                            }
                        },
                        {
                            $unwind: {
                                path: '$userAccount'
                            }
                        },
                        {
                            $project: {
                                _id: 0,
                                displayName: '$userAccount.name',
                                avatar: '$userAccount.avatar'
                            }
                        }
                    ]
                }
            },
            {
                $unwind: { path: '$createdBy' }
            },
            {
                $unwind: { path: '$room' }
            },
            {
                $project: {
                    _id: 0,
                    id: { $toString: '$_id' },
                    roomId: { $toString: '$room._id' },
                    createdAt: 1,
                    displayName: '$room.name',
                    image: '$room.image',
                    connectedMembers: 1,
                    createdBy: 1
                }
            }
        ]);

        if (results.length == 0) throw new NotFoundException('Invite not found or has expired');

        return plainToInstance(InviteDto, results)[0];
    }

    async updateInvite({ accept: accepted, code }: IUpdateInviteRequest, actor: string) {
        const session = await this.inviteModel.db.startSession();
        try {
            await session.withTransaction(async () => {
                const now = new Date();
                const inviteDoc = await this.inviteModel.findOne({
                    code,
                    expiresAt: { $gt: now },
                    $or: [
                        { to: null },
                        { to: actor, accepted: { $ne: true } }
                    ]
                });

                if (!inviteDoc) throw new NotFoundException('Invite not found');
                const update: UpdateQuery<HydratedDocument<Invite>> = {
                    $set: {},
                    $inc: {
                        __v: 1
                    }
                };

                if (inviteDoc.to) {
                    update.$set.accepted = accepted;
                    update.$set.expiresAt = now;
                }
                if (accepted) {
                    update.$push = {
                        acceptors: actor
                    }
                }

                await inviteDoc.updateOne(update, { session }).exec();

                if (accepted) {
                    this.eventEmitter.emit(Events.InvitationAccepted, { inviteId: inviteDoc._id.toString(), userId: actor, roomId: inviteDoc.room, targeted: !!inviteDoc.to });
                } else {
                    this.eventEmitter.emit(Events.InvitationDenied, { inviteId: inviteDoc._id.toString(), userId: actor, roomId: inviteDoc.room, targeted: !!inviteDoc.to });
                }
            })
            await session.commitTransaction();
        } catch (err) {
            await session.abortTransaction();
            throw err
        }
    }

    async createInvite({ roomId, userId: inviteeId, redirect, key }: ICreateRoomInviteRequest, createdBy: string, dbSession?: ClientSession): Promise<[string, string]> {
        const expiresAt = new Date(Date.now() + 3 * 3_600_000);
        const url = new URL(redirect);
        const code = generateRandomToken(3).toUpperCase();
        url.searchParams.set(key, code);
        const doc = await new this.inviteModel({
            room: roomId, to: inviteeId, expiresAt, url: url.toString(), code, createdBy
        }).save({ session: dbSession });

        return [url.toString(), doc._id.toString()];
    }

    async createNotification({ body, title, to, sender, data, image }: ICreateNotificationRequest, dbSession?: ClientSession) {
        const doc = await new this.notificationModel({
            body, title, to, data, from: sender, image
        }).save({ session: dbSession });
        const notification = new Notification(doc.toObject());
        this.eventEmitter.emit(Events.NotificationSent, notification);
    }

    async markAsSeen(...ids: string[]) {
        const result = await this.updatesModel.updateMany(
            {
                _id: { $in: ids.map(id => new Types.ObjectId(id)) }
            }, {
            $set: { seen: true },
            $inc: { __v: 1 }
        });

        this.logger.verbose(`Marked ${result.modifiedCount} notifications as seen`);
    }

    async findNotifications(userId: string, size: number, unseenOnly: boolean, after?: string) {
        const query: FilterQuery<Notification> = {
            to: userId,
        };
        if (after && isMongoId(after))
            query._id = { $gt: after }

        if (unseenOnly) {
            query.seen = { $ne: true };
        }
        const docs = await this.notificationModel.find(query).limit(size).exec();
        return docs.map(doc => new Notification(doc.toObject()));
    }


    getLiveNotifications(userId: string) {
        return fromEvent(this.eventEmitter, Events.NotificationSent).pipe(
            filter(({ _to }: Notification) => _to.toString() == userId),
            map(data => ({ data: instanceToPlain(data), event: 'Notification' } as MessageEvent))
        );
    }
}
