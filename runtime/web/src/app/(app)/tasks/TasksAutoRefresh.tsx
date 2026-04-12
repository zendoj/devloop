'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Polls the server every POLL_MS and calls router.refresh() so
 * the parent server component re-fetches /api/tasks. Plays a
 * notification chime in the browser when the "ready_for_test"
 * count grows between two polls.
 *
 * Sound: a real audio file (universfield notification chime)
 * served from /sounds/notification.{opus,mp3}. Opus is preferred
 * — 2.4s chime comes out ~28 KB instead of 75 KB, and every
 * modern browser supports it. The MP3 is kept as a <source>
 * fallback for the rare legacy case.
 *
 * Browsers block audio playback until the user interacts with
 * the page. We register a one-shot pointerdown/keydown listener
 * that "unlocks" the audio element on the first click anywhere.
 * After that, every new ready_for_test task chimes on the next
 * poll cycle.
 */

const POLL_MS = 5_000;

let unlocked = false;

export function TasksAutoRefresh({
  readyForTestCount,
}: {
  readyForTestCount: number;
}): React.ReactElement {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastCountRef = useRef<number>(readyForTestCount);

  // One-shot user-interaction unlock. On the first click or
  // keypress anywhere on the page we call audio.play() once
  // at volume 0 to satisfy the autoplay policy, then immediately
  // pause and rewind. From that point on .play() works without
  // any gesture.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const unlock = (): void => {
      if (unlocked) return;
      const audio = audioRef.current;
      if (audio) {
        const prevVolume = audio.volume;
        audio.volume = 0;
        audio
          .play()
          .then(() => {
            audio.pause();
            audio.currentTime = 0;
            audio.volume = prevVolume;
            unlocked = true;
          })
          .catch(() => {
            // even the zero-volume unlock failed — will retry
            // on the next user gesture
          });
      } else {
        unlocked = true;
      }
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

  // Chime when the ready_for_test count grows between renders.
  useEffect(() => {
    if (readyForTestCount > lastCountRef.current) {
      const audio = audioRef.current;
      if (audio) {
        try {
          audio.currentTime = 0;
          void audio.play().catch(() => {
            // silent — user hasn't unlocked audio yet
          });
        } catch {
          // silent
        }
      }
    }
    lastCountRef.current = readyForTestCount;
  }, [readyForTestCount]);

  // Poll loop: ask Next.js to re-render the server component so
  // fresh /api/tasks data flows in. router.refresh() only
  // refetches server data — it doesn't do a full navigation, so
  // the user's scroll position and form inputs are preserved.
  useEffect(() => {
    const id = setInterval(() => {
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  return (
    <audio
      ref={audioRef}
      preload="auto"
      style={{ display: 'none' }}
      aria-hidden
    >
      <source src="/sounds/notification.opus" type="audio/ogg; codecs=opus" />
      <source src="/sounds/notification.mp3" type="audio/mpeg" />
    </audio>
  );
}
