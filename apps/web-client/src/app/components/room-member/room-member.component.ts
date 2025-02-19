import { animate, state, style, transition, trigger } from '@angular/animations';
import { Component, DestroyRef, Injector, OnDestroy, computed, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { IRoomSession } from '@chattr/interfaces';
import { Actions, dispatch, ofActionCompleted, ofActionDispatched, select } from '@ngxs/store';
import { Device } from 'mediasoup-client';
import { Consumer } from 'mediasoup-client/lib/Consumer';
import { RtpCapabilities } from 'mediasoup-client/lib/RtpParameters';
import { Transport } from 'mediasoup-client/lib/Transport';
import { Producer, TransportOptions } from 'mediasoup-client/lib/types';
import { AvatarModule } from 'primeng/avatar';
import { CardModule } from 'primeng/card';
import { filter, fromEvent, map, take, takeUntil } from 'rxjs';
import { CloseServerSideConsumer, CloseServerSideProducer, ConnetSessionTransport, ConsumerStreamToggled, CreateServerSideConsumer, CreateServerSideProducer, JoinSession, LeaveSession, RemoteProducerClosed, RemoteProducerOpened, ServerSideConsumerCreated, ServerSideProducerCreated, SessionJoined, SpeakingSessionChanged, ToggleConsumerStream, TransportConnected } from '../../actions';
import { Selectors } from '../../state/selectors';

const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').substring(1);

@Component({
  selector: 'chattr-room-member',
  standalone: true,
  imports: [CardModule, AvatarModule],
  templateUrl: './room-member.component.html',
  styleUrl: './room-member.component.scss',
  animations: [
    trigger('speakerIndicator', [
      state('active', style({
        borderWidth: '5px'
      })),
      state('inactive', style({
        borderWidth: '0'
      })),
      transition('active <=> inactive', [
        animate('50ms linear')
      ])
    ])
  ]
})
export class RoomMemberComponent implements OnDestroy {
  private readonly actions$ = inject(Actions);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  readonly session = input.required<IRoomSession>();
  private readonly producibleSession = select(Selectors.producibleSession);
  private readonly connectionStatus = select(Selectors.connectionStatus);
  private readonly joinSessionFn = dispatch(JoinSession);
  private readonly transportConnectFn = dispatch(ConnetSessionTransport);
  private readonly consumerToggleFn = dispatch(ToggleConsumerStream);
  private readonly producerCloseFn = dispatch(CloseServerSideProducer);
  private readonly closeConsumerFn = dispatch(CloseServerSideConsumer);
  private readonly leaveSessionFn = dispatch(LeaveSession);
  private readonly createServerProducerFn = dispatch(CreateServerSideProducer);
  private readonly createServerConsumerFn = dispatch(CreateServerSideConsumer);
  private readonly preferredAudioDevice = select(Selectors.audioInDevice);
  private readonly preferredVideoDevice = select(Selectors.videoInDevice);
  private readonly isVideoMuted = select(Selectors.isVideoDisabled);
  private readonly isAudioMuted = select(Selectors.isAudioDisabled);
  private readonly consumers = new Map<string, Consumer>();
  private videoProducer?: Producer;
  private audioProducer?: Producer;
  readonly sessionStream = signal<MediaStream | null>(null);
  readonly activeSpeaking = toSignal(this.actions$.pipe(
    ofActionDispatched(SpeakingSessionChanged),
    map(({ sessionId }) => sessionId == this.session().id)
  ));
  readonly videoTrackAvailable = computed(() => {
    const stream = this.sessionStream();
    if (!stream) return false;
    return stream.getVideoTracks().length > 0;
  });
  readonly audioTrackAvailable = computed(() => {
    const stream = this.sessionStream();
    if (!stream) return false;
    return stream.getAudioTracks().length > 0;
  });
  readonly canPublish = computed(() => {
    const producibleSession = this.producibleSession();
    const session = this.session();
    return session.id == producibleSession?.id;
  });
  readonly errored = output<Error>();
  readonly displayName = computed(() => {
    const canPublish = this.canPublish();
    const name = this.session().displayName + (canPublish ? ' (You)' : '');
    return name;
  })
  readonly avatar = computed(() => {
    const { displayName, avatar } = this.session();
    if (avatar) return avatar;
    const defaultUrl = `https://api.dicebear.com/9.x/open-peeps/svg?seed=${encodeURIComponent(displayName)}&scale=80&size=100&backgroundColor=${bgColor}&backgroundType=gradientLinear`;
    return defaultUrl;
  });

  private device = new Device();
  private transport?: Transport;

  ngOnDestroy(): void {
    const currentStream = this.sessionStream();
    if (this.videoProducer?.closed === false) {
      this.videoProducer?.close();
      this.producerCloseFn(this.session().id, this.videoProducer.id);
    }

    if (this.audioProducer?.closed === false) {
      this.audioProducer?.close();
      this.producerCloseFn(this.session().id, this.audioProducer.id);
    }

    const consumers = [...this.consumers.values()];
    for (const consumer of consumers) {
      consumer.close();
    }

    if (currentStream) {
      currentStream.getTracks().forEach(track => track.stop());
    }
    if (this.transport?.connectionState == 'connected') {
      this.transport.close();
    }
    this.leaveSessionFn(this.session().id);
  }

  constructor() {
    this.actions$.pipe(
      takeUntilDestroyed(this.destroyRef),
      ofActionCompleted(SessionJoined),
      filter(({ action }) => action.sessionId == this.session().id),
    ).subscribe(async ({ action: { rtpCapabilities, transportParams } }) => {
      await this.setupDevice(rtpCapabilities);
      this.setupTransports(transportParams);
      if (this.canPublish()) {
        this.startPublishing();
      } else {
        this.startConsuming();
      }
    });
    effect(() => {
      const status = this.connectionStatus();
      if (status === 'connected')
        this.joinSessionFn(this.session().id);
    });
  }

  private startConsuming() {
    for (const producerId of this.session().producers) {
      this.consumeProducerMedia(producerId);
    }
    this.actions$.pipe(
      takeUntilDestroyed(this.destroyRef),
      ofActionCompleted(RemoteProducerOpened),
      filter(({ action: { sessionId } }) => sessionId == this.session().id)
    ).subscribe(({ action: { producerId } }) => {
      this.consumeProducerMedia(producerId);
    });
  }

  private consumeProducerMedia(producerId: string) {
    this.actions$.pipe(
      takeUntilDestroyed(this.destroyRef),
      ofActionDispatched(ServerSideConsumerCreated),
      filter(({ sessionId, producerId: _producerId }) => _producerId == producerId && sessionId == this.session().id),
      take(1)
    ).subscribe(async ({ id, kind, rtpParameters }) => {
      if (!this.transport) return;
      const consumer = await this.transport.consume({ id, kind, producerId, rtpParameters, });

      this.consumers.set(consumer.id, consumer);

      this.actions$.pipe(
        takeUntilDestroyed(this.destroyRef),
        ofActionDispatched(RemoteProducerClosed),
        filter(({ sessionId, producerId: _producerId }) => _producerId == producerId && sessionId == this.session().id),
        take(1)
      ).subscribe(() => {
        consumer.close();
      });

      const consumerStreamToggledCallback = ({ paused }: ConsumerStreamToggled) => {
        const { track } = consumer;
        this.sessionStream.update((currentStream) => {
          const stream = currentStream ?? new MediaStream();
          const tracks = kind == 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
          tracks.forEach((track) => {
            track.stop();
            stream.removeTrack(track);
          });
          if (!paused)
            stream.addTrack(track);
          return stream;
        });
      }

      this.actions$.pipe(
        takeUntilDestroyed(this.destroyRef),
        takeUntil(fromEvent(consumer.observer, 'close')),
        ofActionDispatched(ConsumerStreamToggled),
        filter(({ consumerId }) => consumerId == consumer.id)
      ).subscribe(action => consumerStreamToggledCallback(action));


      consumer.on('trackended', () => {
        const { track } = consumer;
        this.sessionStream.update((currentStream) => {
          if (!currentStream) return null;
          currentStream.removeTrack(track);

          if (currentStream.getTracks().length == 0) return null;
          else {
            return new MediaStream([...currentStream.getTracks(), track]);
          }
        })
      });

      consumer.observer.on('close', () => {
        const { track } = consumer;
        this.sessionStream.update((currentStream) => {
          if (!currentStream) return null;
          currentStream.removeTrack(track);

          if (currentStream.getTracks().length == 0) return null;
          else {
            return new MediaStream([...currentStream.getTracks(), track]);
          }
        });

        this.consumers.delete(consumer.id);
        this.closeConsumerFn(id);
      });

      this.consumerToggleFn(id);

      consumerStreamToggledCallback({ paused: false, consumerId: id });
    });

    this.createServerConsumerFn(producerId, this.session().id, this.device.rtpCapabilities);
  }

  private startPublishing() {
    effect(async () => {
      if (!this.transport) return;
      const audioDevice = this.preferredAudioDevice();
      const videoDevice = this.preferredVideoDevice();
      const videoMuted = this.isVideoMuted();
      const audioMuted = this.isAudioMuted();
      const constraints: MediaStreamConstraints = {};

      let audioProducer: Producer | null = this.audioProducer ?? null;
      let videoProducer: Producer | null = this.videoProducer ?? null;
      let currentStream: MediaStream | null = null;

      if (audioDevice) {
        if (audioMuted && audioProducer) {
          audioProducer.close();
          this.producerCloseFn(this.session().id, audioProducer.id);
          audioProducer = null;
        } else if (!audioMuted) {
          constraints.audio = {
            echoCancellation: true,
            deviceId: audioDevice
          }
        }
      }

      if (videoDevice) {
        if (videoMuted && videoProducer) {
          videoProducer.close();
          this.producerCloseFn(this.session().id, videoProducer.id);
          videoProducer = null;
        } else if (!videoMuted) {
          constraints.video = {
            deviceId: videoDevice
          }
        }
      }

      if (Object.keys(constraints).length > 0) {
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);

        if (constraints.video) {
          const track = currentStream.getVideoTracks()[0];
          videoProducer = videoProducer ?? (await this.transport.produce({ track }));
        }

        if (constraints.audio) {
          const track = currentStream.getAudioTracks()[0];
          audioProducer = audioProducer ?? (await this.transport.produce({ track }));
        }
      }

      this.audioProducer = audioProducer ?? undefined;
      this.videoProducer = videoProducer ?? undefined;
      this.sessionStream.update((previousStream) => {
        if (previousStream) {
          previousStream.getTracks().forEach(track => track.stop());
        }

        if (currentStream && this.canPublish()) {
          const audioTrack = currentStream.getAudioTracks()[0];
          if (audioTrack) {
            currentStream.removeTrack(audioTrack);
          }
        }
        return currentStream;
      });
    }, { injector: this.injector, allowSignalWrites: true });
  }

  private setupTransports(transportParams: TransportOptions) {
    if (this.canPublish()) {
      this.transport = this.device.createSendTransport(transportParams);
      this.transport.on('produce', ({ kind, rtpParameters }, callback, errBack) => {
        this.actions$.pipe(
          takeUntilDestroyed(this.destroyRef),
          ofActionCompleted(ServerSideProducerCreated),
          filter(({ action: { sessionId } }) => sessionId == this.session().id),
          take(1)
        ).subscribe(({ result, action: { producerId } }) => {
          if (result.error) {
            errBack(result.error);
          } else {
            callback({ id: producerId });
          }
        });

        this.createServerProducerFn(this.session().id, kind, rtpParameters);
      });
    } else {
      this.transport = this.device.createRecvTransport(transportParams);
    }
    this.transport.on('connect', ({ dtlsParameters }, callback, errBack) => {
      this.actions$.pipe(
        takeUntilDestroyed(this.destroyRef),
        ofActionCompleted(TransportConnected),
        filter(({ action }) => action.sessionId == this.session().id),
        take(1)
      ).subscribe(({ result }) => {
        if (result.error) {
          errBack(result.error);
        } else {
          callback();
        }
      });
      this.transportConnectFn(this.session().id, dtlsParameters);
    });
  }

  private async setupDevice(rtpCapabilities: RtpCapabilities) {
    this.device = new Device();
    await this.device.load({ routerRtpCapabilities: rtpCapabilities });
  }
}
