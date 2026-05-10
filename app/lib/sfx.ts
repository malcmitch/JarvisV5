/**
 * Lightweight SFX player. Caches Audio objects so repeated calls don't
 * re-parse the file. Each call to play() interrupts the previous instance
 * of the same sound so rapid clicks don't stack infinitely.
 */

const cache: Record<string, HTMLAudioElement> = {};

export type SFXName =
  | 'intro_sfx'
  | 'intro2'
  | 'loading'
  | 'app_close'
  | 'error'
  | 'calculating'
  | 'notification'
  | 'sfx_settings_open'
  | 'switch_interface'
  | 'select'
  | 'click_sfx'
  | 'click'
  | 'select_confirm'
  | 'slide1'
  | 'slide2'
  | 'slide3';

const FILE_MAP: Record<SFXName, string> = {
  intro_sfx:        '/assets/SFX/intro_sfx.mp3',
  intro2:           '/assets/SFX/intro2.MP3',
  loading:          '/assets/SFX/loading.mp3',
  app_close:        '/assets/SFX/app_close.mp3',
  error:            '/assets/SFX/error.mp3',
  calculating:      '/assets/SFX/calculating.wav',
  notification:     '/assets/SFX/notification.wav',
  sfx_settings_open:'/assets/SFX/sfx_settings_open.mp3',
  switch_interface: '/assets/SFX/switch_interface.mp3',
  select:           '/assets/SFX/select.mp3',
  click_sfx:        '/assets/SFX/click_sfx.wav',
  click:            '/assets/SFX/click.wav',
  select_confirm:   '/assets/SFX/select.wav',
  slide1:           '/assets/SFX/slide.MP3',
  slide2:           '/assets/SFX/slide2.MP3',
  slide3:           '/assets/SFX/slide3.MP3',
};

const SLIDE_SFX: SFXName[] = ['slide1', 'slide2', 'slide3'];

export function sfx(name: SFXName, volume = 1, rate = 1): void {
  if (typeof window === 'undefined') return;
  try {
    let audio = cache[name];
    if (!audio) {
      audio = new Audio(FILE_MAP[name]);
      cache[name] = audio;
    }
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.playbackRate = rate;
    audio.currentTime = 0;
    audio.play().catch(() => { /* user hasn't interacted yet — silent fail */ });
  } catch {
    // Non-critical — never throw
  }
}

/** Play a random slide sound — used for widget fly-out animations. */
export function sfxSlide(volume = 1): void {
  const pick = SLIDE_SFX[Math.floor(Math.random() * SLIDE_SFX.length)];
  sfx(pick, volume);
}
