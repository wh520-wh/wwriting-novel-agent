import { gsap } from "./vendor/gsap.js";

export function setupMotion() {
  return { gsapLoaded: Boolean(gsap) };
}

export const motion = {
  setupMotion
};
