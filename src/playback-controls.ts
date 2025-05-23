import { PlaybackState, PlaybackStateInfo, PlaybackStateMachine, PlaybackTransition } from "./state-machine.js";


type TimeBasedState = {
    millisElapsed?: number;
    timer?: number;
    durationMillis: number;
}
type MutablePlaybackStateInfo = {-readonly [K in keyof PlaybackStateInfo]: PlaybackStateInfo[K]}&
        {time?: TimeBasedState;};


/** If numeric, only the range [0..1] is allowed, everything else leads to unspecified behaviour. */
export type StepResult = false|number;

export interface AnimationListener {

    /**
     * Animation start requested. Return false to indicate that running the animation is currently not possible,
     * or a Promise if this requires some task to be completed first, such as (pre-)loading a resource. 
     * @param fraction the initial fraction, a value between 0 and 1
     * @param backwards indicates if the animation is to run backwards
     */
    start?(fraction: number, backwards: boolean): boolean|Promise<boolean>;
    /**
     * Called before the animation progresses to the new state. This is expected to be called frequently when the animation is running. 
     * Returning a promise will suspend the animation until the promise completes. If the promise fails, the animation is stopped. 
     * Do not return a promise if the required data for the animation is already available, in particular do not use an async function here.  
     * @param state 
     */
    move(state: PlaybackStateInfo): boolean|Promise<boolean>;
    /**
     * Animation stopped, either it is finished, or pause or stop has been triggered manually.
     * @param state 
     */
    stopped?(state: PlaybackStateInfo): unknown;

    /**
     * User requests a step forward or backward. Return the resulting fraction, or false if step is not possible.
     * @param fraction 
     * @param backwards 
     */
    step?(fraction: number, backwards: boolean): StepResult|Promise<StepResult>;

}

export type Ticks<T extends string|Date|number> = Array<{fraction: number; tick: T}> |
        ((fraction: number) => T);

/**
 * The state can be externally controlled, via the method move(fraction: number): void, or the
 * state evolution can be timer based (requestAnimationFrame), calling an externally passed callback
 * on every invocation.
 */
export class PlaybackControls extends HTMLElement implements PlaybackStateMachine {

    static readonly #DEFAULT_TAG: string = "playback-controls";
    static readonly #DEFAULT_ANIMATION_DURATION: number = 10_000;  // millis
    static #tag: string|undefined;
    readonly #state: MutablePlaybackStateInfo = {
        state: PlaybackState.STOPPED, 
        fraction: 0,
        isSuspended: false,
        isPlaying() {
            return [PlaybackState.PLAYING, PlaybackState.PLAYING_BACKWARDS].indexOf(this.state) >= 0;
        }

    };
    #suspensionControl: AbortController|undefined;
    readonly #play: HTMLElement;
    readonly #pause: HTMLElement;
    readonly #stop: HTMLElement;
    readonly #playBackward: HTMLElement;
    readonly #progress: HTMLProgressElement;
    readonly #ticksParent: HTMLElement;
    readonly #clickListener: (evt: Event) => void;
    readonly #progressListener: (evt: MouseEvent) => void;
    readonly #stepListener: (evt: KeyboardEvent) => void;
    readonly #enterListener: (evt: KeyboardEvent) => void;

    #animationCallback: AnimationListener|undefined;
    #ticks: Ticks<any>|undefined;
    #numTicks: number|undefined;  // if not set, a reasonable default will be determined

    static get observedAttributes() {
        return ["animation-duration"]; 
    }

    /**
     * Call once to register the new tag type "<playback-controller></playback-controller>"
     * @param tag 
     */
    static register(tag?: string) {
        tag = tag || PlaybackControls.#DEFAULT_TAG;
        if (tag !== PlaybackControls.#tag) {
            customElements.define(tag, PlaybackControls);
            PlaybackControls.#tag = tag;
        }
    }

    /**
     * Retrieve the registered tag type for this element type, or undefined if not registered yet.
     */
    static tag(): string|undefined {
        return PlaybackControls.#tag;
    }

    constructor() {
        super();
        const style: HTMLStyleElement = document.createElement("style");
        style.textContent = ".ctrl-container { display: flex; column-gap: 1em; align-items: center; }\n" +
            ".ctrl-btn { font-size: var(--playback-controls-font-size, 2em); " + 
                "color: var(--playback-controls-color-active, black); }\n" +
            ".ctrl-btn:not([disabled]):hover { cursor: pointer; }\n" +
            ".ctrl-btn[disabled] { color: var(--playback-controls-color-inactive, gray); }\n " +
            ".progress-indicator {margin-left: 1em; width: var(--playback-controls-progress-width, 8em);}\n" +
            ".progress-container {position: relative;}\n" + 
            ".ticks-container>* {position: absolute; top: 1em;}";
        const shadow: ShadowRoot = this.attachShadow({mode: "open", delegatesFocus: true});
        shadow.appendChild(style);
        const controlsContainer = document.createElement("div");
        controlsContainer.classList.add("ctrl-container");
        const play = document.createElement("div");
        const pause = document.createElement("div");
        const stop = document.createElement("div");
        const playBackwards = document.createElement("div");
        const ctrlButtons = [play, playBackwards, pause, stop];
        // https://en.wikipedia.org/wiki/Media_control_symbols
        //const ctrlText = ["&#x23F5;", "&#x23F8;", "&#x23F9;", "&#x23F4;"];
        const ctrlText = ["⏵", "⏴", "⏸", "⏹"];
        const descriptions = ["Play", "Play backwards", "Pause", "Stop"];
        this.#enterListener = this.#enterPressed.bind(this);
        ctrlButtons.forEach((el, idx) => {
            el.textContent = ctrlText[idx];
            el.classList.add("ctrl-btn");
            controlsContainer.appendChild(el);
            el.setAttribute("tabindex", "0");
            el.addEventListener("keydown", this.#enterListener);
            el.setAttribute("aria-role", "button");
            const descr = descriptions[idx];
            el.setAttribute("aria-label", descr);
            el.title = descr;
        });
        const progressParent = document.createElement("div");
        progressParent.classList.add("progress-container");
        const ticksParent = document.createElement("div");
        ticksParent.classList.add("ticks-container");
        const progress = document.createElement("progress");
        progress.max = 100;
        progress.value = 0;
        progress.classList.add("progress-indicator");
        progress.setAttribute("tabindex", "0");
        [pause, stop].forEach(el => PlaybackControls.#deactivate(el));
        controlsContainer.appendChild(progressParent);
        progressParent.appendChild(progress);
        progressParent.appendChild(ticksParent);
        shadow.appendChild(controlsContainer);
        this.#play = play;
        this.#pause = pause;
        this.#stop = stop;
        this.#playBackward = playBackwards;
        this.#progress = progress;
        this.#clickListener = this.#clicked.bind(this);
        this.#progressListener = this.#progressChanged.bind(this);
        this.#stepListener = this.#step.bind(this);
        this.#ticksParent = ticksParent;
        controlsContainer.addEventListener("click", this.#clickListener);
        progress.addEventListener("click", this.#progressListener);
        progress.addEventListener("keydown", this.#stepListener);

    }

    #enterPressed(event: KeyboardEvent) {
        if (event.key !== "Enter")
            return;
        event.preventDefault();
        if (event.currentTarget === this.#play)
            this.start();
        else if (event.currentTarget === this.#playBackward)
            this.start(true);
        else if (event.currentTarget === this.#pause)
            this.pause();
        else if (event.currentTarget === this.#stop)
            this.stop();
    }

    #step(event: KeyboardEvent) {
        const isLeft = event.key === "ArrowLeft";
        const isRight = !isLeft && event.key === "ArrowRight";
        if (!isLeft && !isRight)
            return;
        event.preventDefault();
        if (!this.#animationCallback?.step)
            return;
        const state = this.#state;
        this.#cancelSuspension();
        const doStep = (fraction: number) => this.#moveInternal(fraction);
        const result: StepResult|Promise<StepResult> = this.#animationCallback.step(state.fraction, isLeft);
        if (result === false || result === undefined || result === null)
            return;
        if (PlaybackControls.#isPromise(result)) {
            state.isSuspended = true;
            const [promise, ctrl] = PlaybackControls.#abortablePromise(result as Promise<StepResult>);
            this.#suspensionControl = ctrl;
            promise.then((newFraction: StepResult) => {
                state.isSuspended = false;
                if (typeof newFraction === "number" && newFraction >= 0 && newFraction <= 1)
                    doStep(newFraction);
            }).catch(e => {
                if (!(e instanceof _PlaybackAbortError)) {
                    state.isSuspended = false;
                }
            });
        } else {
            doStep(result as number);
        }

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
        const fraction: number = event.offsetX / target.clientWidth;
        target.value = fraction * 100;
        const value: number = target.value;
        if (!isFinite(value) || value < 0 || value > 100)
            return;
        this.move(value/100);
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
        nowActive.forEach(e => PlaybackControls.#activate(e));
        nowInactive.forEach(e => PlaybackControls.#deactivate(e));
    }

    static #deactivate(el: HTMLElement) {
        el.setAttribute("disabled", "");
        el.setAttribute("aria-disabled", "");
        el.removeAttribute("tabindex");
    }

    static #activate(el: HTMLElement) {
        el.removeAttribute("disabled");
        el.removeAttribute("aria-disabled");
        el.setAttribute("tabindex", "0");
    }

    get animationDuration(): number {
        const anim1 = parseFloat(this.getAttribute("animation-duration")!);
        return anim1 > 0 ? anim1 : PlaybackControls.#DEFAULT_ANIMATION_DURATION;
    }

    set animationDuration(durationMillis: number) {
        if (durationMillis > 0)
            this.setAttribute("animation-duration", durationMillis.toString());
    }

    async attributeChangedCallback(name: string, oldValue: string|null, newValue: string|null) {
        const attr: string = name.toLowerCase();
        switch (attr) {
        case "animation-duration":
            const millis = parseFloat(newValue!);
            if (millis > 0)
                this.#setAnimationDuration(millis);
            break;
        }
    }

    state(): PlaybackStateInfo {
        return {...this.#state};
    }
   
    start(backwards: boolean = false): void {
        if (!this.#animationCallback)
            return;
        const state = this.#state;
        const previousState = {...state};
        if (state.isPlaying() && backwards === (state.state === PlaybackState.PLAYING_BACKWARDS))
            return; // unchanged
        /*
        if ((state.state === PlaybackState.FINISHED && !backwards) ||
                    (state.state === PlaybackState.STOPPED && backwards)) {
            return;  // transition not possible, already at the end
        }
        */
        this.#cancelSuspension();
        state.state = backwards ? PlaybackState.PLAYING_BACKWARDS : PlaybackState.PLAYING;
        if (backwards && state.fraction === 0)
            state.fraction = 1;
        else if (!backwards && state.fraction === 1)
            state.fraction = 0;
        const finishStart = () => {
            state.isSuspended = false;
            this.#started(backwards);
            if (state.time)
                this.#startTimer();    
        };
        const abort = () => {
            Object.assign(state, previousState);
            state.isSuspended = false;
        }
        if (this.#animationCallback.start) {
            const result: boolean|Promise<boolean> = this.#animationCallback.start(state.fraction, backwards);
            if (result === false || result === undefined || result === null) {
                abort();
                return;
            }
            if (PlaybackControls.#isPromise(result)) {
                state.isSuspended = true;
                const [promise, ctrl] = PlaybackControls.#abortablePromise(result as Promise<boolean>);
                this.#suspensionControl = ctrl;
                promise.then(doStart => {
                    if (doStart) {
                        finishStart();
                    } else {
                        abort();
                    }
                }).catch(e => {
                    if (!(e instanceof _PlaybackAbortError)) {
                        abort();
                    }
                });
            } else {
                finishStart();
            }
        } else {
            finishStart();
        }
    }
    #started(backwards: boolean) {
        const nowInactive = backwards ? this.#playBackward : this.#play;
        const nowActive = [backwards ? this.#play : this.#playBackward, this.#pause, this.#stop];
        PlaybackControls.#updateActivation(nowActive, [nowInactive]);
    }
    stop(): void {
        const state = this.#state;
        state.state = PlaybackState.STOPPED;
        this.#cancelSuspension();
        this.#moveInternal(0);
        if (this.#animationCallback?.stopped)
            this.#animationCallback.stopped({...state});
    }
    finish(): void {
        const state = this.#state;
        state.state = PlaybackState.FINISHED;
        this.#cancelSuspension();
        this.#moveInternal(1);
        if (this.#animationCallback?.stopped)
            this.#animationCallback.stopped({...state});
    }
    pause(): void {
        const state = this.#state;
        this.#cancelSuspension();
        if (state.fraction <= 0) {
            this.stop();
            return;
        } else if (state.fraction >= 1) {
            this.finish();
            return;
        }
        state.state = PlaybackState.PAUSED;
        this.#paused();
        this.#cancelTimer();
        if (this.#animationCallback?.stopped)
            this.#animationCallback.stopped({...state});        
    }
    #paused() {
        PlaybackControls.#updateActivation([this.#play, this.#playBackward, this.#stop], [this.#pause]);
    }

    move(fraction: number = 0) {
        this.#cancelSuspension();  // not working
        const state = this.#state;
        const previousState = {...state};
        const result: boolean|Promise<boolean>|undefined = this.#animationCallback?.move({...previousState, fraction: fraction});
        const abort = () => {
            state.isSuspended = false;
            state.fraction = previousState.fraction;
            this.pause();
        }
        if (result === false || result === undefined || result === null) {
            abort();
            return;
        }
        const finalize = () => {
            state.isSuspended = false;
            this.#moveInternal(fraction);
            const type = [PlaybackState.PLAYING, PlaybackState.PLAYING_BACKWARDS].indexOf(state.state) >= 0 ?
                        "jumpplaying" : "jumppaused";
            this.#dispatchEvent(type, previousState);
        }
        if (PlaybackControls.#isPromise(result)) {
            state.isSuspended = true;
            const [promise, ctrl] = PlaybackControls.#abortablePromise(result as Promise<boolean>);
            this.#suspensionControl = ctrl;
            promise.then(doContinue => {
                if (doContinue) {
                    finalize();
                } else {
                    abort();
                }
            }).catch(e => {
                if (!(e instanceof _PlaybackAbortError)) {
                    abort();
                }
            });
        } else {
            finalize();
        }
    }

     #moveInternal(fraction: number = 0, options?: {skipTimer?: boolean;}): void {
        if (!options?.skipTimer)
            this.#cancelTimer();
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
                PlaybackControls.#updateActivation([this.#play, this.#playBackward], [this.#pause, this.#stop]);
            } else {
                state.state = fraction === 1 ? PlaybackState.FINISHED : PlaybackState.PAUSED;
                PlaybackControls.#updateActivation([this.#play, this.#playBackward, this.#stop], [this.#pause]);
            }
            if (this.#animationCallback?.stopped) {
                try {
                    this.#animationCallback.stopped({...state});
                } catch (e) {}
            }
        } else {  // playing
            const isBackwards = state.state === PlaybackState.PLAYING_BACKWARDS;
            const active = isBackwards ? this.#play : this.#playBackward;
            const inactive = isBackwards ? this.#playBackward : this.#play;
            PlaybackControls.#updateActivation([active, this.#stop, this.#pause], [inactive]);   
        }
        this.#progress.value = fraction * 100;
        if (this.#ticks)
            this.#setTicks(fraction);
        if (state.time && !options?.skipTimer) {
            const oneOff = !state.isPlaying();
            this.#startTimer({oneOff: oneOff});
        }
    }

    setAnimationListener(listener: AnimationListener|undefined): void {
        if (this.#state.time) {
            this.#cancelTimer();
            delete this.#state.time;
        }
        this.#animationCallback = listener;
        if (!listener)
            return;
        this.#state.time = {
            durationMillis: this.animationDuration
        };
        if (this.#state.isPlaying())
            this.#startTimer();
    }

    #setAnimationDuration(durationMillis: number) {
        if (!(durationMillis! > 0))
            return;
        const wasPlaying = this.#state.isPlaying() && this.#state.time;
        if (!wasPlaying)
            return;
        const wasBackward = wasPlaying && this.#state.state === PlaybackState.PLAYING_BACKWARDS;
        this.pause();
        this.#state.time!.durationMillis = durationMillis!;
        this.start(wasBackward);
    }

    #startTimer(options?: {oneOff?: boolean;}) {
        const state = this.#state;
        const timeInfo: TimeBasedState|undefined = state.time;
        if (!timeInfo)
            return;
        this.#cancelTimer();
        if (!state.isPlaying() && !options?.oneOff)  // state must be set to playing prior to this call
            return;
        const initialFraction = state.fraction; // should be 0 for forward and 1 for backward mode
        let start: number|undefined = undefined;
        const run = (timestamp: number) => {
            if (start === undefined)
                start = timestamp;
            const passed = timestamp - start;
            timeInfo.millisElapsed = passed;
            const backwards = state.state === PlaybackState.PLAYING_BACKWARDS;
            const fraction = backwards ? Math.max(0, initialFraction - (passed / timeInfo.durationMillis)) : 
                    Math.min(1, passed / timeInfo.durationMillis + initialFraction);
            if (fraction === 1 && !backwards) {
                this.finish();
                return;
            } else if (fraction === 0 && backwards) {
                this.stop();
                return;
            }
            const result: boolean|Promise<boolean> = this.#animationCallback!.move({...this.#state, fraction: fraction});
            if (options?.oneOff) {
                delete timeInfo.timer;
            } else if (result === false || result === undefined || result === null) {
                this.pause();
            } else {
                const isPromise = typeof result === "object" && typeof result.then === "function";
                if (isPromise) {
                    state.isSuspended = true;
                    const suspensionStart = globalThis.performance.now();
                    const [promise, ctrl] = PlaybackControls.#abortablePromise(result as Promise<boolean>);
                    this.#suspensionControl = ctrl;
                    promise.then(doContinue => {
                        if (doContinue) {
                            state.isSuspended = false;
                            const elapsed = globalThis.performance.now() - suspensionStart;
                            start = start! + elapsed;
                            this.#moveInternal(fraction, {skipTimer: true});
                            timeInfo.timer = globalThis.requestAnimationFrame(run);
                        } else {
                            state.isSuspended = false;
                            this.pause();
                        }
                    }).catch(e => {
                        if (!(e instanceof _PlaybackAbortError)) {
                            state.isSuspended = false;
                            this.pause();
                        }
                    });
                } else {  // returned true
                    this.#moveInternal(fraction, {skipTimer: true});
                    timeInfo.timer = globalThis.requestAnimationFrame(run);
                }
            }
            /*
            if (!options?.oneOff)
                timeInfo.timer = globalThis.requestAnimationFrame(run);
            else
                delete timeInfo.timer;
            */
        };
        timeInfo.millisElapsed = 0;
        timeInfo.timer = globalThis.requestAnimationFrame(run);
    }

    #cancelTimer() {
        const timer = this.#state.time?.timer;
        if (timer === undefined)
            return;
        globalThis.cancelAnimationFrame(timer);
        delete this.#state.time!.timer;
        delete this.#state.time!.millisElapsed;
    }

    #cancelSuspension() {
        if (this.#state.isSuspended) {
            this.#suspensionControl?.abort();
            this.#suspensionControl = undefined;
            this.#state.isSuspended = false;
        }
    }

    set ticks(ticks: Ticks<any>|undefined) {
        this.#ticks = Array.isArray(ticks) ? [...ticks] : ticks; // TODO update view
        if (ticks)
            this.#setTicks(this.#state.fraction);
        else
            this.#removeTicks();
    }

    get ticks(): Ticks<any>|undefined {
        if (Array.isArray(this.#ticks))
            return [...this.#ticks];
        return this.#ticks;
    }

    #setTicks(fraction: number) {
        this.#removeTicks();
        const progressWidth = this.#progress.clientWidth;
        const ticks = this.#ticks;
        if (!(progressWidth > 0) || !ticks)
            return;
        const isFunction = typeof ticks === "function";
        const first = isFunction ? ticks(0) : ticks[0].toString();
        const last = isFunction ? ticks(1) : ticks[ticks.length - 1].toString();
        const dummyCanvas = document.createElement("canvas");
        const ctx = dummyCanvas.getContext("2d")!;
        const totalWidth = ctx.measureText(first).width + ctx.measureText(last).width;
        let numTicks = Math.floor(progressWidth / totalWidth * 2);
        numTicks = Math.max(2, numTicks);
        if (this.#numTicks)
            numTicks = Math.min(this.#numTicks, numTicks);
        if (!isFunction)
            numTicks = Math.min(ticks.length, numTicks);
        this.#drawTicks(numTicks, isFunction, fraction);
    }

    #drawTicks(numTicks: number, isFunction: boolean, fraction: number) {
        const frag = document.createDocumentFragment();
        const elements: Array<HTMLElement> = [];
        const values: Array<string|number|Date> = [];
        for (let idx=0; idx<numTicks; idx++) {
            const tickFraction = idx / (numTicks-1);
            const tick = isFunction ? (this.#ticks as Function)(tickFraction) : 
                            (this.#ticks as Array<any>)[Math.round(tickFraction * (this.#ticks!.length-1))].tick;
            const tickEl = document.createElement("div");
            elements.push(tickEl);
            values.push(tick);
            tickEl.style.left = "calc(var(--playback-controls-progress-width, 8em) * " + tickFraction + ")";
            frag.appendChild(tickEl);
        }
        const valueStrings: Array<string> = PlaybackControls.#format(values);
        valueStrings.forEach((v, idx) => elements[idx].textContent = v);
        this.#ticksParent.appendChild(frag);
    }

    #removeTicks() {
        const ticksParent = this.#ticksParent;
        while (ticksParent.firstChild)
            ticksParent.firstChild.remove();
    }

    static #isPromise(obj: any): boolean {
        return typeof obj === "object" && typeof obj.then === "function";
    }

    static #abortablePromise<T>(promise: Promise<T>): [Promise<T>, AbortController] {
        const ctrl = new AbortController();
        return [Promise.race([promise, new Promise<T>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new _PlaybackAbortError())))]), ctrl];
    }

    static #format<T extends number|string|Date>(values: Array<T>): Array<string> {
        const l = values.length;
        if (l === 0)
            return []
        if (l === 1 || typeof values[0] === "string")
            return values.map(v => v.toString());
        if (values[0] instanceof Date) {
            // TODO handle case of intra-day variation
            return (values as Array<Date>).map(d => d.getFullYear() + "-" + (d.getMonth()+1) + "-" + d.getDate()); 
        }
         // TODO better number formatting
        return values.map(v => v.toString());

    }



}

class _PlaybackAbortError extends Error {}
