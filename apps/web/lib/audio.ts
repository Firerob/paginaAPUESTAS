/**
 * Audio del juego, sintetizado en el navegador.
 *
 * Sin archivos y sin CDN: todo se genera con osciladores de WebAudio. Eso
 * evita descargas, evita depender de un host externo y hace que el bundle no
 * crezca ni un kilobyte por sonido.
 *
 * Los navegadores bloquean el audio hasta que hay un gesto real del usuario,
 * asi que el contexto se crea perezosamente en el primer click o toque. Antes
 * de eso todas las llamadas son inertes: no lanzan, simplemente no suenan.
 */

type SoundName =
  | "hit"
  | "wall"
  | "goal"
  | "victory"
  | "defeat"
  | "countdown"
  | "start";

const STORAGE_KEY = "ah:muted";

class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;

  constructor() {
    if (typeof window !== "undefined") {
      try {
        this.muted = localStorage.getItem(STORAGE_KEY) === "1";
      } catch {
        /* localStorage puede estar bloqueado */
      }
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(STORAGE_KEY, this.muted ? "1" : "0");
    } catch {
      /* ignorado */
    }
    if (this.master) {
      this.master.gain.value = this.muted ? 0 : 0.35;
    }
    return this.muted;
  }

  /**
   * Se llama desde el primer gesto del usuario. Antes de eso el navegador
   * crearia el contexto en estado "suspended" y nada sonaria.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;

      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      // Sin audio no pasa nada: el juego se juega igual.
      this.ctx = null;
    }
  }

  play(name: SoundName, intensity = 1): void {
    if (!this.ctx || !this.master || this.muted) return;
    const now = this.ctx.currentTime;

    switch (name) {
      case "hit":
        // Golpe seco y agudo; el tono sube con la fuerza del impacto.
        this.blip(now, 420 + intensity * 520, 0.06, "square", 0.5 * intensity);
        this.noise(now, 0.04, 0.18 * intensity, 2200);
        break;

      case "wall":
        this.blip(now, 160 + intensity * 90, 0.07, "triangle", 0.32 * intensity);
        this.noise(now, 0.05, 0.12 * intensity, 900);
        break;

      case "goal":
        // Arpegio ascendente + ruido: celebracion corta, sin marear.
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
          this.blip(now + i * 0.07, freq, 0.22, "sawtooth", 0.28);
        });
        this.noise(now, 0.3, 0.2, 3200);
        break;

      case "victory":
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((freq, i) => {
          this.blip(now + i * 0.11, freq, 0.42, "square", 0.24);
        });
        break;

      case "defeat":
        [392, 349.23, 293.66, 233.08].forEach((freq, i) => {
          this.blip(now + i * 0.15, freq, 0.5, "sawtooth", 0.2);
        });
        break;

      case "countdown":
        this.blip(now, 660, 0.1, "square", 0.3);
        break;

      case "start":
        this.blip(now, 880, 0.25, "square", 0.35);
        this.blip(now + 0.02, 1320, 0.28, "square", 0.2);
        break;
    }
  }

  /** Un tono con envolvente exponencial. */
  private blip(
    at: number,
    frequency: number,
    duration: number,
    type: OscillatorType,
    gain: number,
  ): void {
    if (!this.ctx || !this.master) return;

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);

    // Ataque muy corto y caida exponencial: sin el ataque se oye un "click"
    // por el salto brusco de amplitud.
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), at + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    osc.connect(env);
    env.connect(this.master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** Rafaga de ruido filtrada, para dar cuerpo a los impactos. */
  private noise(at: number, duration: number, gain: number, cutoff: number): void {
    if (!this.ctx || !this.master) return;

    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    source.start(at);
  }
}

export const gameAudio = new GameAudio();
