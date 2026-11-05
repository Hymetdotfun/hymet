"use client";

import { useEffect, useRef } from "react";
import { cosmicMeteorOpacity } from "./cosmic-canvas";

type Star = { x: number; y: number; radius: number; alpha: number; phase: number; rate: number };
export type DocsMeteor = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  width: number;
  brightness: number;
  age: number;
  life: number;
  fadeIn: number;
  fadeOut: number;
};

/** The head fades out before this share of the width, so wide layouts keep streaks clear of the copy. */
export const docsMeteorStopRatio = (width: number) => (width < 620 ? 0.2 : 0.52);

export function createDocsMeteor(width: number, height: number, random: () => number = Math.random): DocsMeteor {
  const narrow = width < 620;
  const between = (min: number, max: number) => min + random() * (max - min);
  const x = width * (narrow ? between(0.7, 1.15) : between(0.8, 1.12));
  const y = height * between(-0.12, 0.32);
  const speed = width * (narrow ? between(0.45, 0.7) : between(0.18, 0.3));
  const angle = between(0.5, 0.68);
  const vx = -Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  const brightness = between(0.35, 1);
  const untilStop = (x - width * docsMeteorStopRatio(width)) / -vx;
  const untilFloor = (height * 0.92 - y) / vy;
  const life = Math.min(untilStop, untilFloor);
  return {
    x,
    y,
    vx,
    vy,
    length: (narrow ? 70 : 90) + brightness * (narrow ? 90 : 190),
    width: 0.7 + brightness * 1.1,
    brightness,
    age: 0,
    life,
    fadeIn: Math.min(0.4, life * 0.2),
    fadeOut: Math.min(1, life * 0.4),
  };
}

/** The lower-right atmosphere never changes, so it is painted once and only copied each frame. */
function createAtmosphere(width: number, height: number, scale: number) {
  const texture = document.createElement("canvas");
  texture.width = Math.max(1, Math.ceil(width * scale));
  texture.height = Math.max(1, Math.ceil(height * scale));
  const sky = texture.getContext("2d");
  if (!sky) return texture;
  sky.setTransform(scale, 0, 0, scale, 0, 0);
  sky.globalCompositeOperation = "lighter";

  const paintEllipse = (x: number, y: number, radiusX: number, radiusY: number, rotation: number, stops: [number, string][]) => {
    sky.save();
    sky.translate(x, y);
    sky.rotate(rotation);
    sky.scale(1, radiusY / radiusX);
    const glow = sky.createRadialGradient(0, 0, 0, 0, 0, radiusX);
    for (const [at, color] of stops) glow.addColorStop(at, color);
    sky.fillStyle = glow;
    sky.beginPath();
    sky.arc(0, 0, radiusX, 0, Math.PI * 2);
    sky.fill();
    sky.restore();
  };

  paintEllipse(width * 0.88, height * 0.86, width * 0.62, height * 0.46, -0.2, [
    [0, "rgba(54, 221, 185, 0.17)"],
    [0.42, "rgba(38, 150, 130, 0.075)"],
    [1, "rgba(20, 80, 70, 0)"],
  ]);
  paintEllipse(width * 0.74, height * 0.8, width * 0.34, Math.max(9, height * 0.028), -0.13, [
    [0, "rgba(116, 255, 225, 0.2)"],
    [0.5, "rgba(54, 221, 185, 0.06)"],
    [1, "rgba(54, 221, 185, 0)"],
  ]);

  // Sparse grain gives the glow depth without a flat gradient.
  const grains = Math.min(170, Math.floor((width * height) / 3200));
  for (let index = 0; index < grains; index++) {
    const spread = Math.pow(Math.random(), 0.65);
    const x = width * (1.02 - spread * 0.62);
    const y = height * (1 - (1 - spread) * 0.42 - Math.random() * 0.16);
    sky.fillStyle = `rgba(122, 240, 215, ${0.03 + Math.random() * 0.13})`;
    sky.beginPath();
    sky.arc(x, y, 0.25 + Math.random() * 0.75, 0, Math.PI * 2);
    sky.fill();
  }

  // Dissolve toward the hero's right and bottom edges so the glow never shows a clipped rectangle.
  sky.globalCompositeOperation = "destination-in";
  const fadeRight = sky.createLinearGradient(width * 0.82, 0, width, 0);
  fadeRight.addColorStop(0, "rgba(0, 0, 0, 1)");
  fadeRight.addColorStop(1, "rgba(0, 0, 0, 0)");
  sky.fillStyle = fadeRight;
  sky.fillRect(0, 0, width, height);
  const fadeBottom = sky.createLinearGradient(0, height * 0.72, 0, height);
  fadeBottom.addColorStop(0, "rgba(0, 0, 0, 1)");
  fadeBottom.addColorStop(1, "rgba(0, 0, 0, 0)");
  sky.fillStyle = fadeBottom;
  sky.fillRect(0, 0, width, height);
  return texture;
}

/** The docs introduction's sky: the homepage's twinkle and meteor treatment, without its heavier effects. */
export function DocsCosmicBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let frame = 0;
    let visible = true;
    let lastTime = 0;
    let lastDrawn = 0;
    let nextMeteor = 0;
    let stars: Star[] = [];
    let meteors: DocsMeteor[] = [];
    let atmosphere: HTMLCanvasElement | null = null;

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      if (atmosphere) context.drawImage(atmosphere, 0, 0, width, height);

      for (const star of stars) {
        const twinkle = media.matches ? 0.8 : 0.58 + 0.42 * Math.sin(time * 0.001 * star.rate + star.phase);
        // Stars thin out toward the copy on the left.
        const quiet = 0.28 + 0.72 * Math.min(1, star.x / (width * 0.62));
        context.fillStyle = `rgba(214, 255, 247, ${star.alpha * twinkle * quiet})`;
        context.beginPath();
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
      }

      context.save();
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";
      for (const meteor of meteors) {
        const opacity = cosmicMeteorOpacity(meteor.age, meteor.fadeIn, meteor.life - meteor.fadeOut, meteor.fadeOut) * meteor.brightness;
        if (opacity <= 0) continue;
        const headX = meteor.x + meteor.vx * meteor.age;
        const headY = meteor.y + meteor.vy * meteor.age;
        const speed = Math.hypot(meteor.vx, meteor.vy);
        const tail = Math.min(meteor.length, speed * meteor.age + 40);
        const tailX = headX - (meteor.vx / speed) * tail;
        const tailY = headY - (meteor.vy / speed) * tail;
        const trail = context.createLinearGradient(headX, headY, tailX, tailY);
        trail.addColorStop(0, `rgba(190, 255, 240, ${0.9 * opacity})`);
        trail.addColorStop(0.22, `rgba(116, 255, 225, ${0.42 * opacity})`);
        trail.addColorStop(1, "rgba(54, 221, 185, 0)");
        context.strokeStyle = trail;
        context.lineWidth = meteor.width;
        context.beginPath();
        context.moveTo(headX, headY);
        context.lineTo(tailX, tailY);
        context.stroke();
        const glowRadius = 3 + meteor.width * 4;
        const glow = context.createRadialGradient(headX, headY, 0, headX, headY, glowRadius);
        glow.addColorStop(0, `rgba(226, 255, 249, ${0.85 * opacity})`);
        glow.addColorStop(0.3, `rgba(116, 255, 225, ${0.28 * opacity})`);
        glow.addColorStop(1, "rgba(54, 221, 185, 0)");
        context.fillStyle = glow;
        context.beginPath();
        context.arc(headX, headY, glowRadius, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    };

    const tick = (time: number) => {
      frame = 0;
      if (!visible || document.hidden || media.matches) return;
      const elapsed = Math.min(0.05, (time - lastTime) / 1000 || 0);
      lastTime = time;
      for (const meteor of meteors) meteor.age += elapsed;
      meteors = meteors.filter((meteor) => meteor.age < meteor.life);
      if (time >= nextMeteor && meteors.length < 2) {
        meteors.push(createDocsMeteor(width, height));
        nextMeteor = time + 2400 + Math.random() * 3800;
      }
      // Twinkling alone needs far fewer frames than a moving meteor.
      if (meteors.length || time - lastDrawn >= 66) {
        draw(time);
        lastDrawn = time;
      }
      frame = window.requestAnimationFrame(tick);
    };

    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const start = () => {
      if (frame || !visible || document.hidden || media.matches) return;
      lastTime = performance.now();
      frame = window.requestAnimationFrame(tick);
    };

    /** Reduced motion gets one still frame: the same sky with a single meteor at rest. */
    const drawStill = () => {
      const meteor = createDocsMeteor(width, height);
      meteor.age = meteor.life * 0.5;
      meteor.brightness = 0.7;
      meteors = [meteor];
      draw(0);
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width));
      const nextHeight = Math.max(1, Math.round(bounds.height));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(36, Math.min(120, Math.floor((width * height) / 7000)));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: Math.random() < 0.08 ? 1 + Math.random() * 0.7 : 0.35 + Math.random() * 0.6,
        alpha: 0.25 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2,
        rate: 0.35 + Math.random() * 1.1,
      }));
      atmosphere = createAtmosphere(width, height, Math.min(dpr, 1));
      meteors = [];
      if (media.matches) drawStill();
      else draw(performance.now());
    };

    const handleVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const handleMotion = () => {
      stop();
      if (media.matches) drawStill();
      else {
        meteors = [];
        start();
      }
    };

    const intersection = "IntersectionObserver" in window
      ? new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
          if (visible) start();
          else stop();
        }, { rootMargin: "80px 0px" })
      : null;
    intersection?.observe(canvas);
    const sizing = "ResizeObserver" in window ? new ResizeObserver(resize) : null;
    sizing?.observe(canvas);
    document.addEventListener("visibilitychange", handleVisibility);
    media.addEventListener("change", handleMotion);
    resize();
    nextMeteor = performance.now() + 500;
    start();

    return () => {
      stop();
      intersection?.disconnect();
      sizing?.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      media.removeEventListener("change", handleMotion);
      atmosphere = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="dh-cosmic-background" aria-hidden="true" />;
}
