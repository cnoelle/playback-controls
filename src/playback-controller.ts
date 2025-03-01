import { PlaybackState, PlaybackStateInfo, PlaybackStateMachine, PlaybackTransition } from "./state-machine.js";


type MutablePlaybackStateInfo = {-readonly [K in keyof PlaybackStateInfo]: PlaybackStateInfo[K]};

export class PlaybackController extends HTMLElement implements PlaybackStateMachine {

    static readonly #DEFAULT_TAG: string = "playback-controller";
    static #tag: string|undefined;
    readonly #state: MutablePlaybackStateInfo = {state: PlaybackState.STOPPED, fraction: 0};
    readonly #play: HTMLElement;
    readonly #pause: HTMLElement;
    readonly #stop: HTMLElement;
    readonly #playBackward: HTMLElement;
    readonly #progress: HTMLProgressElement;
    readonly #clickListener: (evt: Event) => void;
    readonly #progressListener: (evt: MouseEvent) => void;

    static get observedAttributes() {
        return []; 
    }

    /**
     * Call once to register the new tag type "<playback-controller></playback-controller>"
     * @param tag 
     */
    static register(tag?: string) {
        tag = tag || PlaybackController.#DEFAULT_TAG;
        if (tag !== PlaybackController.#tag) {
            customElements.define(tag, PlaybackController);
            PlaybackController.#tag = tag;
        }
    }

    /**
     * Retrieve the registered tag type for this element type, or undefined if not registered yet.
     */
    static tag(): string|undefined {
        return PlaybackController.#tag;
    }

    constructor() {
        super();
        const style: HTMLStyleElement = document.createElement("style");
        // TODO
        /*style.textContent = ":host { position: relative; display: block; }";*/
        style.textContent = ".ctrl-container { display: flex; column-gap: 1em; align-items: center; }\n" +
            ".ctrl-btn { font-size: 2em; }\n" +
            ".ctrl-btn:not([disabled]):hover { cursor: pointer; }\n" +
            ".ctrl-btn[disabled] { color: gray; }\n " +
            ".progress-indicator {margin-left: 1em; width: 8em;} ";
        const shadow: ShadowRoot = this.attachShadow({mode: "open"});
        shadow.appendChild(style);
        const controlsContainer = document.createElement("div");
        controlsContainer.classList.add("ctrl-container");
        const play = document.createElement("div");
        const pause = document.createElement("div");
        const stop = document.createElement("div");
        [pause, stop].forEach(el => el.setAttribute("disabled", ""))
        const playBackwards = document.createElement("div");
        const ctrlButtons = [play, playBackwards, pause, stop];
        // https://en.wikipedia.org/wiki/Media_control_symbols
        //const ctrlText = ["&#x23F5;", "&#x23F8;", "&#x23F9;", "&#x23F4;"];
        const ctrlText = ["⏵", "⏴", "⏸", "⏹"];
        const ctrlTitle = ["Play", "Play backwards", "Pause", "Stop"];
        ctrlButtons.forEach((el, idx) => {
            el.textContent = ctrlText[idx];
            el.title = ctrlTitle[idx];
            el.classList.add("ctrl-btn");
            controlsContainer.appendChild(el);
        });
        const progress = document.createElement("progress");
        progress.max = 100;
        progress.value = 0;
        progress.classList.add("progress-indicator");
        controlsContainer.appendChild(progress);
        shadow.appendChild(controlsContainer);
        this.#play = play;
        this.#pause = pause;
        this.#stop = stop;
        this.#playBackward = playBackwards;
        this.#progress = progress;
        this.#clickListener = this.#clicked.bind(this);
        this.#progressListener = this.#progressChanged.bind(this);
        controlsContainer.addEventListener("click", this.#clickListener);
        progress.addEventListener("click", this.#progressListener);
    }

    #clicked(event: Event) {
        const target = event.target as HTMLElement;
        if (!target.classList.contains("ctrl-btn"))
            return;
        const disabledAttr = target.getAttribute("disabled");
        const isDisabled = disabledAttr !== null && disabledAttr !== undefined;
        if (isDisabled)
            return;
        const state = this.#state;
        const previousState = {...state};
        let type;
        if (target === this.#play || target === this.#playBackward) {
            const isBackwards = target === this.#playBackward;
            this.start(isBackwards);
            type = isBackwards ? "startreverse": "start";
        } else if (target === this.#pause) {
            this.pause();
            type = "pause";
        } else if (target === this.#stop) {
            this.stop();
            type = "stop";
        }  else {
            return;
        }
        this.#dispatchEvent(type, previousState);
    }

    #progressChanged(event: MouseEvent) {
        const target = event.currentTarget as HTMLProgressElement;
        const fraction: number = (event.clientX - target.offsetLeft) / target.clientWidth;
        target.value = fraction * 100;
        const value: number = target.value;
        if (!isFinite(value) || value < 0 || value > 100)
            return;
        const state = this.#state;
        const previousState = {...state};
        this.move(value/100);
        const type = [PlaybackState.PLAYING, PlaybackState.PLAYING_BACKWARDS].indexOf(state.state) >= 0 ?
                    "jumpplaying" : "jumppaused";
        this.#dispatchEvent(type, previousState);
    }

    #dispatchEvent(type: string, oldState: PlaybackStateInfo) {
        const transition: PlaybackTransition = {
            from: Object.freeze(oldState),
            to: Object.freeze({...this.#state})
        };
        const newEvent = new CustomEvent<PlaybackTransition>(type, {detail: transition});
        this.dispatchEvent(newEvent);  // report to external listeners
        this.dispatchEvent(new CustomEvent<PlaybackTransition>("change", {detail: transition}));
    }

    static #updateActivation(nowActive: Array<HTMLElement>, nowInactive: Array<HTMLElement>) {
        nowActive.forEach(e => PlaybackController.#activate(e));
        nowInactive.forEach(e => PlaybackController.#deactivate(e));
    }

    static #deactivate(el: HTMLElement) {
        el.setAttribute("disabled", "");
    }

    static #activate(el: HTMLElement) {
        el.removeAttribute("disabled");
    }

    state(): PlaybackStateInfo {
        return {...this.#state};
    }
   
    start(backwards: boolean = false): void {
        const state = this.#state;
        if ((state.state === PlaybackState.FINISHED && !backwards) ||
                    (state.state === PlaybackState.STOPPED && backwards)) {
            return;  // transition not possible, already at the end
        }
        state.state = backwards ? PlaybackState.PLAYING_BACKWARDS : PlaybackState.PLAYING;
        this.#started(backwards);
    }
    #started(backwards: boolean) {
        const nowInactive = backwards ? this.#playBackward : this.#play;
        const nowActive = [backwards ? this.#play : this.#playBackward, this.#pause, this.#stop];
        PlaybackController.#updateActivation(nowActive, [nowInactive]);
    }
    stop(): void {
        this.#state.state = PlaybackState.STOPPED;
        this.move(0);
    }
    finish(): void {
        this.#state.state = PlaybackState.FINISHED;
        this.move(1);
    }
    pause(): void {
        const state = this.#state;
        if (state.fraction <= 0) {
            this.stop();
            return;
        } else if (state.fraction >= 1) {
            this.finish();
            return;
        }
        state.state = PlaybackState.PAUSED;
        this.#paused();
    }
    #paused() {
        PlaybackController.#updateActivation([this.#play, this.#playBackward, this.#stop], [this.#pause]);
    }
    move(fraction: number = 0): void {
        if (fraction < 0)
            fraction = 0;
        else if (fraction > 1)
            fraction = 1;
        else if (!isFinite(fraction))
            throw new Error("Invalid fraction: " + fraction);
        const state = this.#state;
        state.fraction = fraction;
        if ([PlaybackState.PAUSED, PlaybackState.STOPPED, PlaybackState.FINISHED].indexOf(state.state) >= 0
                    || (fraction === 0 && state.state === PlaybackState.PLAYING_BACKWARDS)
                    || (fraction === 1 && state.state === PlaybackState.PLAYING)) {
            if (fraction === 0) {
                state.state = PlaybackState.STOPPED;
                PlaybackController.#updateActivation([this.#play, this.#playBackward], [this.#pause, this.#stop]);
            } else {
                state.state = fraction === 1 ? PlaybackState.FINISHED : PlaybackState.PAUSED;
                PlaybackController.#updateActivation([this.#play, this.#playBackward, this.#stop], [this.#pause]);
            }
        } else {  // playing
            const isBackwards = state.state === PlaybackState.PLAYING_BACKWARDS;
            const active = isBackwards ? this.#play : this.#playBackward;
            const inactive = isBackwards ? this.#playBackward : this.#play;
            PlaybackController.#updateActivation([active, this.#stop, this.#pause], [inactive]);   
        }
        this.#progress.value = fraction * 100;
    }


}