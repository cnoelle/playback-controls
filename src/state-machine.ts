export enum PlaybackState {
    STOPPED = "stopped",
    PLAYING = "playing",
    FINISHED = "finished",
    PAUSED = "paused",
    PLAYING_BACKWARDS = "playing_backwards",
};

export interface PlaybackStateInfo {
    readonly state: PlaybackState;
    /**
     * A number between 0 and 1, indicating the completion fraction.
     * State STOPPED must have fraction 0, state FINISHED must have fraction 1.
     */
    readonly fraction: number;
    readonly isSuspended: boolean;

    isPlaying(): boolean;
}

export interface PlaybackTransition {
    readonly from: PlaybackStateInfo;
    readonly to: PlaybackStateInfo;
}

export interface PlaybackStateMachine {
    state(): PlaybackStateInfo;
    start(backwards?: boolean): void;
    stop(): void;
    finish(): void;
    pause(): void;
    /**
     * @param fraction default: 0
     */
    move(fraction?: number): void;
    /**
     * Note: the listener is not notified when the start(), stop(), pause() or reset() methods are called,
     * only when the action is initiated by the user via the interface.
     * @param event "change" is a catchall for the fine-grained events
     * @param listener 
     */
    addEventListener(event: "start"|"startreverse"|"stop"|"jumpplaying"|"jumppaused"|"change", 
                listener: (evt: CustomEvent<PlaybackTransition>) => void): void;
    
}