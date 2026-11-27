export const OVERLAY_MOTION = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } },
} as const;
