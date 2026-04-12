'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Polls the server every POLL_MS and calls router.refresh() so
 * the parent server component re-fetches /api/tasks. Also beeps
 * in the browser when the "ready_for_test" count increases
 * between two polls — that's the "you have a task to accept or
 * reject" notification.
 *
 * Sound: a short 440Hz sine tone via WebAudio, no external
 * asset file. Most browsers block autoplay until the first user
 * interaction, so we register a one-shot pointerdown listener
 * that "unlocks" the AudioContext on any click anywhere on the
 * page. After that, beeps work on every new ready_for_test task.
 */

const POLL_MS = 5_000;

let audioCtx: AudioContext | null = null;
let unlocked = false;

function ensureAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    try {
      const Ctor =
        (window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }).AudioContext ??
        (window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

function beep(): void {
  const ctx = ensureAudio();
  if (!ctx || !unlocked) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.setValueAtTime(660, now + 0.15);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
  gain.gain.linearRampToValueAtTime(0, now + 0.35);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}

export function TasksAutoRefresh({
  readyForTestCount,
}: {
  readyForTestCount: number;
}): React.ReactElement | null {
  const router = useRouter();
  const lastCountRef = useRef<number>(readyForTestCount);

  // One-shot user-interaction unlock for the AudioContext.
  // Browsers silently mute WebAudio until the user clicks
  // anywhere; we register a capture-phase listener that runs
  // once on the very first pointer/keydown event and resumes
  // the context so subsequent beep() calls actually produce
  // sound.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const unlock = (): void => {
      const ctx = ensureAudio();
      if (ctx && ctx.state === 'suspended') {
        void ctx.resume();
      }
      unlocked = true;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);

  // Beep when the ready_for_test count grows between renders.
  // The parent server component passes the current count as a
  // prop every time it re-renders. We stash the previous value
  // in a ref and compare on each prop change.
  useEffect(() => {
    if (readyForTestCount > lastCountRef.current) {
      beep();
    }
    lastCountRef.current = readyForTestCount;
  }, [readyForTestCount]);

  // Poll loop: every POLL_MS ask Next.js to re-render the
  // server component so fresh data flows in from /api/tasks.
  // router.refresh() only refetches server data — it doesn't
  // do a full navigation, so the user's scroll position and
  // form inputs are preserved.
  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  return null;
}
