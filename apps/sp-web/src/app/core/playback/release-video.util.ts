/**
 * Stops a video for good: paused, its source let go, and loaded empty.
 * Taking a playing <video> off the page isn't enough on an iPhone, which
 * keeps its sound going in the background until the app is closed.
 */
export function releaseVideo(video: HTMLVideoElement | null | undefined): void {
  if (!video) {
    return;
  }
  try {
    video.pause();
    video.removeAttribute('src');
    video.srcObject = null;
    video.load();
  } catch {
    // A video that never started has nothing to let go of.
  }
}
