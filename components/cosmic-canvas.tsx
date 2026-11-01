"use client";

import { useEffect, useRef } from "react";

type Star = {
  x: number;
  y: number;
  z: number;
  radius: number;
  alpha: number;
  phase: number;
  rate: number;
  tint: number;
  flare: boolean;
};
type Dust = {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  phase: number;
  drift: number;
  parallax: number;
};
type MeteorKind = "distant" | "medium" | "cinematic";
type Meteor = {
  kind: MeteorKind;
  startX: number;
  startY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  curve: number;
  travelDuration: number;
  age: number;
  fadeInDuration: number;
  fadeOutStart: number;
  fadeOutDuration: number;
  length: number;
  width: number;
  radius: number;
  hue: number;
};
type CollisionFragment = {
  delay: number;
  vx: number;
  vy: number;
  gravity: number;
  size: number;
  life: number;
  hue: number;
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const gaussian = () => {
  const u = Math.max(Number.EPSILON, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(Math.PI * 2 * Math.random());
};
const smoothstep = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};
const easeInOutCubic = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

export function cosmicMeteorOpacity(
  age: number,
  fadeInDuration: number,
  fadeOutStart: number,
  fadeOutDuration: number,
) {
  const fadeIn = smoothstep(age / fadeInDuration);
  const fadeOut = 1 - smoothstep((age - fadeOutStart) / fadeOutDuration);
  return Math.max(0, Math.min(1, fadeIn * fadeOut));
}

export function shouldRetainCosmicMeteor(opacity: number, fullyOutside: boolean) {
  return opacity > 0 || !fullyOutside;
}

function createGalaxyTexture(width: number, height: number, scale: number) {
  const texture = document.createElement("canvas");
  texture.width = Math.max(1, Math.ceil(width * scale));
  texture.height = Math.max(1, Math.ceil(height * scale));
  const sky = texture.getContext("2d");
  if (!sky) return texture;
  sky.setTransform(scale, 0, 0, scale, 0, 0);

  // A quiet diagonal nebula band, composed only from soft procedural fields.
  sky.save();
  sky.globalCompositeOperation = "screen";
  sky.translate(width * 0.52, height * 0.47);
  sky.rotate(-0.31);
  sky.scale(1, 0.3);
  const bandRadius = width * 0.64;
  const band = sky.createRadialGradient(0, 0, bandRadius * 0.08, 0, 0, bandRadius);
  band.addColorStop(0, "rgba(61, 177, 174, 0.095)");
  band.addColorStop(0.33, "rgba(40, 128, 150, 0.09)");
  band.addColorStop(0.62, "rgba(31, 83, 114, 0.045)");
  band.addColorStop(1, "rgba(25, 67, 99, 0)");
  sky.fillStyle = band;
  sky.beginPath();
  sky.ellipse(0, 0, bandRadius, bandRadius * 0.63, 0, 0, Math.PI * 2);
  sky.fill();
  sky.restore();

  // Irregular diffuse knots keep the formation cloud-like instead of geometric.
  sky.save();
  sky.globalCompositeOperation = "screen";
  for (let i = 0; i < 115; i++) {
    const along = rand(-0.78, 0.78);
    const x = width * (0.52 + along * 0.52) + gaussian() * width * 0.025;
    const centerY = height * (0.48 - along * 0.26);
    const y = centerY + gaussian() * height * 0.085;
    const radius = rand(width * 0.012, width * 0.055);
    const colors = [
      "rgba(71, 202, 190, 0.043)",
      "rgba(72, 151, 193, 0.038)",
      "rgba(107, 224, 214, 0.027)",
      "rgba(140, 166, 208, 0.024)",
    ];
    const cloud = sky.createRadialGradient(x, y, 0, x, y, radius);
    cloud.addColorStop(0, colors[Math.floor(Math.random() * colors.length)]);
    cloud.addColorStop(0.3, "rgba(52, 131, 164, 0.025)");
    cloud.addColorStop(1, "rgba(25, 75, 105, 0)");
    sky.fillStyle = cloud;
    sky.beginPath();
    sky.ellipse(x, y, radius * rand(0.65, 1.55), radius * rand(0.35, 0.8), rand(-0.9, 0.9), 0, Math.PI * 2);
    sky.fill();
  }
  // Sparse grain inside the nebula gives the background depth without a flat glow.
  for (let i = 0; i < Math.min(420, Math.floor((width * height) / 4800)); i++) {
    const along = rand(-0.75, 0.75);
    const x = width * (0.52 + along * 0.52) + gaussian() * width * 0.024;
    const y = height * (0.48 - along * 0.26) + gaussian() * height * 0.09;
    sky.beginPath();
    sky.fillStyle = Math.random() > 0.7
      ? `rgba(134, 236, 229, ${rand(0.06, 0.2)})`
      : `rgba(111, 158, 201, ${rand(0.035, 0.1)})`;
    sky.arc(x, y, rand(0.25, 1.25), 0, Math.PI * 2);
    sky.fill();
  }
  sky.restore();
  return texture;
}

/** A procedural, client-only space field. Animation state stays outside React. */
export function CosmicCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    let width = 0;
    let height = 0;
    let collisionFloor = 0;
    let dpr = 1;
    let textureScale = 0.5;
    let frame = 0;
    let visible = false;
    let lastTime = 0;
    let nextMeteor = 0;
    let nextLargeMeteor = 0;
    let collisionElapsed = -rand(2.6, 4.3);
    let collisionFragments: CollisionFragment[] = [];
    let collisionImpactSeeded = false;
    let pointerX = 0;
    let pointerY = 0;
    let easedX = 0;
    let easedY = 0;
    let stars: Star[] = [];
    let dust: Dust[] = [];
    let meteors: Meteor[] = [];
    let galaxy: HTMLCanvasElement | null = null;

    const seedStars = () => {
      const constrained = (navigator.hardwareConcurrency || 8) <= 4;
      const area = width * height;
      const target = Math.max(
        160,
        Math.min(
          coarsePointer || constrained ? 410 : 780,
          Math.floor(area / (coarsePointer || constrained ? 1650 : 1250)),
        ),
      );
      const clusters = Array.from({ length: 6 }, () => ({
        x: rand(width * 0.06, width * 0.94),
        y: rand(height * 0.08, height * 0.92),
      }));
      stars = Array.from({ length: target }, (_, index) => {
        const clustered = index < target * 0.53;
        const cluster = clusters[Math.floor(Math.random() * clusters.length)];
        return {
          x: clustered
            ? cluster.x + gaussian() * width * 0.028
            : Math.random() * width,
          y: clustered
            ? cluster.y + gaussian() * height * 0.052
            : Math.random() * height,
          z: rand(0.12, 1),
          radius: Math.random() < 0.075 ? rand(1.25, 2.2) : rand(0.35, 1.25),
          alpha: rand(0.22, 0.86),
          phase: rand(0, Math.PI * 2),
          rate: rand(0.18, 1.15),
          tint: Math.random(),
          flare: Math.random() < 0.018,
        };
      });
      const dustCount = Math.max(
        35,
        Math.min(coarsePointer || constrained ? 88 : 154, Math.floor(area / 12500)),
      );
      dust = Array.from({ length: dustCount }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: rand(0.5, coarsePointer ? 1.8 : 2.5),
        alpha: rand(0.035, 0.15),
        phase: rand(0, Math.PI * 2),
        drift: rand(1, 5.5),
        parallax: rand(0.3, 1),
      }));
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const heroCopy = canvas.parentElement?.querySelector<HTMLElement>(".cosmic-copy");
      const copyBounds = heroCopy?.getBoundingClientRect();
      collisionFloor = copyBounds
        ? Math.max(0, Math.min(height, copyBounds.top - bounds.top - 18))
        : height * 0.32;
      const constrained = (navigator.hardwareConcurrency || 8) <= 4;
      dpr = Math.min(window.devicePixelRatio || 1, coarsePointer || constrained ? 1.2 : 1.6);
      textureScale = Math.min(dpr * 0.62, 0.9);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedStars();
      galaxy = createGalaxyTexture(width, height, textureScale);
      // Keep existing streaks alive through resize; gently retire them in the
      // new viewport so changing bounds can never make a visible trail pop.
      for (const meteor of meteors) {
        meteor.fadeOutStart = Math.min(meteor.fadeOutStart, meteor.age + 0.22);
      }
      const now = performance.now();
      nextMeteor = now + rand(2400, 5200);
      nextLargeMeteor = now + rand(1500, 2800);
      // Preserve the collision clock and in-flight fragments across viewport resizes.
      if (media.matches) draw(now, false);
    };

    const spawnMeteor = (now: number, kind: MeteorKind) => {
      const isLarge = kind === "cinematic";
      const isDistant = kind === "distant";
      const direction = Math.random() < 0.5 ? -1 : 1;
      const upperLane = Math.random() < 0.58;
      const crossingDuration = isLarge
        ? rand(9, 11.5)
        : isDistant
          ? rand(3.8, 5.8)
          : rand(6, 8.4);
      const slope = rand(0.015, isLarge ? 0.105 : 0.135) * (upperLane ? 1 : -1);
      const length = isLarge ? rand(560, 840) : isDistant ? rand(110, 185) : rand(250, 430);
      const radius = isLarge ? rand(14, 19) : isDistant ? rand(6, 9) : rand(9, 13);
      const x = direction > 0 ? -radius - 8 : width + radius + 8;
      // Time the head through the viewport, then leave enough travel for the
      // tail and its glow to clear the far edge after its fade has completed.
      const speed = (width + radius * 2 + 16) / crossingDuration;
      const y = upperLane
        ? rand(0.055, 0.15) * height
        : rand(0.79, 0.92) * height;
      const vy = (Math.sign(slope) * Math.abs(slope) * height) / crossingDuration;
      const horizontalExit = direction > 0
        ? (width + radius + 8 - x) / (direction * speed)
        : (-radius - 8 - x) / (direction * speed);
      const verticalExit = vy > 0
        ? (height + radius + 8 - y) / vy
        : vy < 0
          ? (-radius - 8 - y) / vy
          : Number.POSITIVE_INFINITY;
      const fadeOutStart = Math.max(0, Math.min(horizontalExit, verticalExit));
      meteors.push({
        kind,
        startX: x,
        startY: y,
        x,
        y,
        vx: direction * speed,
        vy,
        curve: rand(-0.028, 0.028) * height,
        travelDuration: crossingDuration,
        age: 0,
        fadeInDuration: isLarge ? 1.15 : isDistant ? 0.55 : 0.82,
        fadeOutStart,
        fadeOutDuration: isLarge ? 1.9 : isDistant ? 1.05 : 1.45,
        length,
        width: isLarge ? rand(2.5, 3.6) : isDistant ? rand(0.8, 1.25) : rand(1.5, 2.3),
        radius,
        hue: Math.random(),
      });
      if (isLarge) nextLargeMeteor = now + rand(22000, 35000);
      else nextMeteor = now + rand(3800, 8500);
    };

    const meteorOpacity = (meteor: Meteor) => {
      return cosmicMeteorOpacity(
        meteor.age,
        meteor.fadeInDuration,
        meteor.fadeOutStart,
        meteor.fadeOutDuration,
      );
    };

    const meteorHasCleared = (meteor: Meteor) => {
      // Include the full radial bloom and its canvas shadow blur when deciding
      // whether a faded streak can release its slot.
      const pad = meteor.radius * 3.8 + meteor.width * 4;
      const speed = Math.hypot(meteor.vx, meteor.vy);
      const tailAge = Math.max(0, meteor.age - meteor.length / speed);
      const span = Math.max(1, meteor.age - tailAge);
      const points = Array.from({ length: 9 }, (_, index) => {
        const age = tailAge + (span * index) / 8;
        return {
          x: meteor.startX + meteor.vx * age,
          y: meteor.startY + meteor.vy * age + meteor.curve * Math.sin(Math.PI * age / meteor.travelDuration),
        };
      });
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const minX = Math.min(...xs) - pad;
      const maxX = Math.max(...xs) + pad;
      const minY = Math.min(...ys) - pad;
      const maxY = Math.max(...ys) + pad;
      return maxX < 0 || minX > width || maxY < 0 || minY > height;
    };

    const drawMeteor = (meteor: Meteor, opacity: number) => {
      if (opacity <= 0) return;
      const speed = Math.hypot(meteor.vx, meteor.vy);
      const tailAge = Math.max(0, meteor.age - meteor.length / speed);
      const tailCount = meteor.kind === "cinematic" ? 30 : 22;
      const positions = Array.from({ length: tailCount + 1 }, (_, index) => {
        const age = tailAge + ((meteor.age - tailAge) * index) / tailCount;
        return {
          age,
          x: meteor.startX + meteor.vx * age,
          y: meteor.startY + meteor.vy * age + meteor.curve * Math.sin(Math.PI * age / meteor.travelDuration),
        };
      });
      const cyan = meteor.hue > 0.74 ? "132, 225, 255" : "116, 255, 225";
      const headRadius = meteor.kind === "cinematic" ? 3.2 : meteor.kind === "medium" ? 2.3 : 1.35;
      const glowRadius = meteor.radius * 1.65;
      context.save();
      // A single alpha encloses every luminous component so the whole streak
      // fades together and no independently drawn glow can pop at the edge.
      context.globalAlpha = opacity;
      const strokeLayers = [
        { width: meteor.width * 3.1, alpha: 0.11, blur: glowRadius * 0.8 },
        { width: meteor.width * 1.45, alpha: 0.28, blur: glowRadius * 0.24 },
        { width: meteor.width * 0.46, alpha: 0.9, blur: 0 },
      ];
      context.lineCap = "round";
      context.lineJoin = "round";
      context.globalCompositeOperation = "lighter";
      for (const layer of strokeLayers) {
        context.shadowColor = `rgba(${cyan}, ${layer.alpha})`;
        context.shadowBlur = layer.blur;
        for (let index = 0; index < tailCount; index++) {
          const from = positions[index];
          const to = positions[index + 1];
          const progress = (index + 0.5) / tailCount;
          const taper = Math.pow(progress, 1.7);
          const eased = 0.08 + taper * 0.92;
          context.globalAlpha = opacity * layer.alpha * eased;
          context.strokeStyle = layer === strokeLayers[2]
            ? `rgba(235, 255, 252, ${0.88 * eased})`
            : `rgba(${cyan}, ${eased})`;
          context.lineWidth = Math.max(0.32, layer.width * (0.18 + taper * 0.82));
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();
        }
      }

      // A handful of stable, tiny fragments break up the perfect streak.
      context.shadowBlur = glowRadius * 0.22;
      for (let index = 0; index < 5; index++) {
        const location = 0.34 + index * 0.125 + Math.sin(meteor.hue * 31 + index) * 0.025;
        const pointIndex = Math.max(1, Math.min(tailCount - 1, Math.floor(location * tailCount)));
        const point = positions[pointIndex];
        const fragmentRadius = meteor.width * (0.23 + (index % 3) * 0.08);
        context.globalAlpha = opacity * (0.15 + ((index * 7) % 5) * 0.025) * location;
        context.fillStyle = index % 2 ? `rgba(${cyan}, 0.8)` : "rgba(235, 255, 252, 0.85)";
        context.beginPath();
        context.arc(point.x, point.y, fragmentRadius, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = opacity;
      context.shadowColor = `rgba(${cyan}, 0.65)`;
      context.shadowBlur = glowRadius;
      const glow = context.createRadialGradient(meteor.x, meteor.y, 0, meteor.x, meteor.y, glowRadius);
      glow.addColorStop(0, `rgba(${cyan}, 0.16)`);
      glow.addColorStop(0.42, `rgba(${cyan}, 0.11)`);
      glow.addColorStop(1, `rgba(${cyan}, 0)`);
      context.fillStyle = glow;
      context.beginPath();
      context.arc(meteor.x, meteor.y, glowRadius, 0, Math.PI * 2);
      context.fill();

      const core = context.createRadialGradient(
        meteor.x - headRadius * 0.18,
        meteor.y - headRadius * 0.18,
        headRadius * 0.08,
        meteor.x,
        meteor.y,
        headRadius,
      );
      core.addColorStop(0, "rgba(255, 255, 255, 1)");
      core.addColorStop(0.55, "rgba(238, 255, 251, 0.98)");
      core.addColorStop(1, `rgba(${cyan}, 0.12)`);
      context.shadowBlur = meteor.width * 2.4;
      context.shadowColor = `rgba(${cyan}, 0.7)`;
      context.fillStyle = core;
      context.beginPath();
      context.arc(meteor.x, meteor.y, headRadius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    };

    const drawCollisionMeteor = (
      x: number,
      y: number,
      directionX: number,
      directionY: number,
      side: number,
      opacity: number,
    ) => {
      if (opacity <= 0) return;
      const magnitude = Math.max(0.001, Math.hypot(directionX, directionY));
      const ux = directionX / magnitude;
      const uy = directionY / magnitude;
      const tailLength = Math.min(170, Math.max(78, width * 0.12));
      const tailX = x - ux * tailLength;
      const tailY = y - uy * tailLength;

      context.save();
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";
      context.lineJoin = "round";
      const samples = 20;
      const pointAt = (t: number) => ({
        x: tailX + (x - tailX) * t,
        y: tailY + (y - tailY) * t,
      });
      for (let index = 0; index < samples; index++) {
        const fromT = index / samples;
        const toT = (index + 1) / samples;
        const from = pointAt(fromT);
        const to = pointAt(toT);
        const taper = Math.pow((fromT + toT) * 0.5, 1.75);
        context.globalAlpha = opacity * (0.035 + taper * 0.3);
        context.strokeStyle = "#36DDB9";
        context.lineWidth = 0.35 + taper * 3.1;
        context.shadowColor = "rgba(54, 221, 185, 0.72)";
        context.shadowBlur = 8 + taper * 12;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();

        context.globalAlpha = opacity * (0.025 + taper * 0.72);
        context.strokeStyle = "rgba(238, 255, 251, 0.9)";
        context.lineWidth = 0.22 + taper * 0.95;
        context.shadowBlur = 2 + taper * 5;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }

      context.globalAlpha = opacity;
      context.shadowColor = "rgba(91, 255, 220, 0.8)";
      context.shadowBlur = coarsePointer ? 16 : 24;
      const radius = coarsePointer ? 3.1 : 4.1;
      const glow = context.createRadialGradient(x, y, 0, x, y, radius * 5.5);
      glow.addColorStop(0, "rgba(255, 255, 255, 0.94)");
      glow.addColorStop(0.17, "rgba(202, 255, 242, 0.68)");
      glow.addColorStop(0.48, "rgba(54, 221, 185, 0.18)");
      glow.addColorStop(1, "rgba(54, 221, 185, 0)");
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, radius * 5.5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#F5FFFC";
      context.shadowBlur = 7;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    };

    const seedCollisionFragments = () => {
      const count = coarsePointer ? 16 : 28;
      collisionFragments = Array.from({ length: count }, () => {
        // Chips retain part of one incoming meteor's lateral momentum, while
        // the collision ejects most material downward into the sky.
        const sourceDirection = Math.random() < 0.58 ? 1 : -1;
        const incomingMomentum = Math.min(68, width / 3.75 * 0.2);
        return {
          delay: rand(0, 0.13),
          vx: sourceDirection * incomingMomentum + rand(-34, 34),
          vy: rand(18, 75) + Math.min(18, height / 3.75 * 0.035),
          gravity: rand(40, 74),
          size: rand(0.9, coarsePointer ? 1.75 : 2.4),
          life: rand(3.8, 5.2),
          hue: Math.random(),
        };
      });
    };

    const drawCollision = (dt: number) => {
      collisionElapsed += dt;
      if (collisionElapsed < 0) return;
      const elapsed = collisionElapsed;
      const approachDuration = 3.75;
      const impactTime = approachDuration;
      const sequenceDuration = 9.4;
      if (elapsed > sequenceDuration) {
        // Debris has fully faded before the next sequence is scheduled.
        collisionElapsed = -rand(3.8, 4.8);
        collisionFragments = [];
        collisionImpactSeeded = false;
        return;
      }

      const targetX = width * 0.5;
      // This upper sky lane stays above the centered headline on desktop and mobile.
      const targetY = height * 0.1;
      const progress = Math.min(1, elapsed / approachDuration);
      const travel = easeInOutCubic(progress);
      const startLeft = { x: -width * 0.075, y: height * 0.015 };
      const startRight = { x: width * 1.075, y: height * 0.075 };
      const left = {
        x: startLeft.x + (targetX - startLeft.x) * travel,
        y: startLeft.y + (targetY - startLeft.y) * travel,
      };
      const right = {
        x: startRight.x + (targetX - startRight.x) * travel,
        y: startRight.y + (targetY - startRight.y) * travel,
      };
      const approachOpacity = smoothstep(progress / 0.11);
      const impactAge = elapsed - impactTime;
      const strikeFade = impactAge < 0 ? 1 : 1 - smoothstep(impactAge / 0.2);
      const headingOpacity = approachOpacity * strikeFade;
      const vectorX = targetX - startLeft.x;
      const vectorY = targetY - startLeft.y;
      drawCollisionMeteor(left.x, left.y, vectorX, vectorY, -1, headingOpacity);
      drawCollisionMeteor(right.x, right.y, targetX - startRight.x, targetY - startRight.y, 1, headingOpacity);

      if (elapsed >= impactTime && !collisionImpactSeeded) {
        seedCollisionFragments();
        collisionImpactSeeded = true;
      }

      if (impactAge >= 0 && impactAge < 0.44) {
        const fade = 1 - smoothstep(impactAge / 0.44);
        const radius = (coarsePointer ? 27 : 39) + impactAge * (coarsePointer ? 74 : 96);
        context.save();
        context.globalCompositeOperation = "lighter";
        const flashRadius = (coarsePointer ? 28 : 42) * (1 + impactAge * 2.2);
        const flash = context.createRadialGradient(targetX, targetY, 0, targetX, targetY, flashRadius);
        flash.addColorStop(0, `rgba(244, 255, 252, ${0.72 * fade})`);
        flash.addColorStop(0.16, `rgba(190, 255, 240, ${0.32 * fade})`);
        flash.addColorStop(0.52, `rgba(54, 221, 185, ${0.12 * fade})`);
        flash.addColorStop(1, "rgba(54, 221, 185, 0)");
        context.fillStyle = flash;
        context.beginPath();
        context.arc(targetX, targetY, flashRadius, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = `rgba(174, 255, 235, ${0.4 * fade})`;
        context.lineWidth = 1.1;
        context.translate(targetX, targetY);
        context.scale(1, 0.58);
        context.beginPath();
        context.arc(0, 0, radius, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }

      if (impactAge >= 0 && collisionFragments.length) {
        context.save();
        context.globalCompositeOperation = "lighter";
        context.lineCap = "round";
        for (const fragment of collisionFragments) {
          const age = impactAge - fragment.delay;
          if (age < 0 || age >= fragment.life) continue;
          const x = targetX + fragment.vx * age;
          const y = targetY + fragment.vy * age + 0.5 * fragment.gravity * age * age;
          const previousAge = Math.max(0, age - 0.2);
          const previousX = targetX + fragment.vx * previousAge;
          const previousY = targetY + fragment.vy * previousAge + 0.5 * fragment.gravity * previousAge * previousAge;
          const fadeIn = smoothstep(age / 0.12);
          const fadeOut = 1 - smoothstep((age - fragment.life * 0.72) / (fragment.life * 0.28));
          // Keep collision fallout in the open sky lane; fade each fragment
          // before it can cross the hero copy or CTA buttons.
          const fallFade = 1 - smoothstep((y - (collisionFloor - 34)) / 34);
          const alpha = fadeIn * fadeOut * fallFade;
          if (alpha <= 0.002) continue;
          const cyan = fragment.hue > 0.72 ? "157, 237, 255" : "101, 255, 215";
          context.globalAlpha = alpha * 0.76;
          context.strokeStyle = `rgba(${cyan}, 0.88)`;
          context.lineWidth = fragment.size * 0.78;
          context.shadowColor = `rgba(${cyan}, 0.72)`;
          context.shadowBlur = 6;
          context.beginPath();
          context.moveTo(previousX, previousY);
          context.lineTo(x, y);
          context.stroke();
          context.globalAlpha = alpha;
          context.fillStyle = "rgba(226, 255, 247, 0.9)";
          context.beginPath();
          context.arc(x, y, fragment.size, 0, Math.PI * 2);
          context.fill();
        }
        context.restore();
      }
    };

    const draw = (now: number, animate: boolean) => {
      context.fillStyle = "#050807";
      context.fillRect(0, 0, width, height);

      if (galaxy) {
        const driftX = animate ? Math.sin(now * 0.000045) * 8 + easedX * 4 : 0;
        const driftY = animate ? Math.cos(now * 0.000038) * 6 + easedY * 3 : 0;
        context.globalAlpha = 0.94;
        context.drawImage(
          galaxy,
          driftX,
          driftY,
          width,
          height,
        );
        context.globalAlpha = 1;
      }

      // Dust layers drift at different rates, producing gentle depth over the nebula.
      for (const particle of dust) {
        if (animate) {
          particle.y -= particle.drift * 0.16;
          particle.x += Math.sin(now * 0.00012 + particle.phase) * 0.025;
        }
        if (particle.y < -5) particle.y = height + 5;
        if (particle.x < -5) particle.x = width + 5;
        if (particle.x > width + 5) particle.x = -5;
        const shimmer = animate
          ? 0.7 + Math.sin(now * 0.00022 + particle.phase) * 0.3
          : 0.8;
        context.beginPath();
        context.fillStyle = `rgba(134, 232, 226, ${particle.alpha * shimmer})`;
        context.arc(
          particle.x + easedX * particle.parallax * 6,
          particle.y + easedY * particle.parallax * 5,
          particle.radius,
          0,
          Math.PI * 2,
        );
        context.fill();
      }

      // Distant stars sit almost still; nearer stars shift slightly with pointer depth.
      for (const star of stars) {
        const cycle = (Math.sin(now * 0.001 * star.rate + star.phase) + 1) * 0.5;
        const twinkle = animate ? 0.26 + cycle * 0.74 : 0.78;
        const alpha = star.alpha * twinkle;
        const px = star.x + easedX * star.z * 9;
        const py = star.y + easedY * star.z * 7;
        const radius = star.radius * (0.78 + star.z * 0.38);
        const color = star.tint > 0.9
          ? `rgba(112, 245, 229, ${alpha})`
          : star.tint > 0.72
            ? `rgba(171, 219, 255, ${alpha * 0.8})`
            : `rgba(235, 245, 244, ${alpha})`;
        context.beginPath();
        context.fillStyle = color;
        context.arc(px, py, radius, 0, Math.PI * 2);
        context.fill();
        if (star.flare && radius > 1.25) {
          context.strokeStyle = `rgba(195, 255, 248, ${alpha * 0.26})`;
          context.lineWidth = 0.55;
          context.beginPath();
          context.moveTo(px - radius * 2.6, py);
          context.lineTo(px + radius * 2.6, py);
          context.moveTo(px, py - radius * 2.6);
          context.lineTo(px, py + radius * 2.6);
          context.stroke();
        }
      }

      if (animate) {
        const dt = Math.min(0.04, Math.max(0, (now - lastTime) / 1000));
        lastTime = now;
        easedX += (pointerX - easedX) * 0.018;
        easedY += (pointerY - easedY) * 0.018;
        // Keep occasional small streaks in the quiet intervals; the paired collision
        // owns the larger cinematic beats and stays visually distinct.
        if (
          now >= nextLargeMeteor &&
          meteors.length < 3 &&
          meteors.every((meteor) => meteor.kind !== "cinematic")
        )
          spawnMeteor(now, "cinematic");
        if (now >= nextMeteor && meteors.length < 3)
          spawnMeteor(now, Math.random() < 0.34 ? "distant" : "medium");
        meteors = meteors.filter((meteor) => {
          meteor.age += dt;
          meteor.x = meteor.startX + meteor.vx * meteor.age;
          meteor.y = meteor.startY + meteor.vy * meteor.age + meteor.curve * Math.sin(Math.PI * meteor.age / meteor.travelDuration);
          const opacity = meteorOpacity(meteor);
          drawMeteor(meteor, opacity);
          // Fade first, then retain the object until every part of its visual
          // bounds has moved out of the live canvas. No slot is reused early.
          return shouldRetainCosmicMeteor(opacity, meteorHasCleared(meteor));
        });
        drawCollision(dt);
      } else {
        // A system motion-preference change freezes the field in place rather
        // than clearing a streak mid-frame; no motion continues in this mode.
        for (const meteor of meteors) drawMeteor(meteor, meteorOpacity(meteor));
      }

      // Protect centered copy while leaving the sky luminous around the edges.
      const readability = context.createRadialGradient(
        width * 0.5,
        height * 0.48,
        height * 0.035,
        width * 0.5,
        height * 0.48,
        width * 0.56,
      );
      readability.addColorStop(0, "rgba(4, 8, 8, 0.36)");
      readability.addColorStop(0.52, "rgba(4, 8, 8, 0.12)");
      readability.addColorStop(1, "rgba(4, 8, 8, 0)");
      context.fillStyle = readability;
      context.fillRect(0, 0, width, height);

      const vignette = context.createRadialGradient(
        width * 0.5,
        height * 0.47,
        height * 0.1,
        width * 0.5,
        height * 0.47,
        Math.max(width, height) * 0.74,
      );
      vignette.addColorStop(0, "rgba(4, 7, 7, 0)");
      vignette.addColorStop(0.66, "rgba(4, 7, 7, 0.12)");
      vignette.addColorStop(1, "rgba(4, 7, 7, 0.74)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);
    };

    const tick = (now: number) => {
      if (!visible || document.hidden || media.matches) {
        frame = 0;
        return;
      }
      draw(now, true);
      frame = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (visible && !document.hidden && !media.matches && !frame) {
        lastTime = performance.now();
        frame = window.requestAnimationFrame(tick);
      } else if (media.matches) draw(performance.now(), false);
    };
    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };
    const handleVisibility = () => (document.hidden ? stop() : start());
    const handleMotion = () => {
      if (media.matches) {
        stop();
        draw(performance.now(), false);
      } else start();
    };
    const handlePointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const bounds = canvas.getBoundingClientRect();
      pointerX = Math.max(
        -1,
        Math.min(1, (event.clientX - (bounds.left + width / 2)) / Math.max(1, width / 2)),
      );
      pointerY = Math.max(
        -1,
        Math.min(1, (event.clientY - (bounds.top + height / 2)) / Math.max(1, height / 2)),
      );
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) start();
        else stop();
      },
      { threshold: 0, rootMargin: "80px 0px" },
    );
    observer.observe(canvas);
    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("pointermove", handlePointer, { passive: true });
    document.addEventListener("visibilitychange", handleVisibility);
    media.addEventListener("change", handleMotion);
    resize();

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointer);
      document.removeEventListener("visibilitychange", handleVisibility);
      media.removeEventListener("change", handleMotion);
      galaxy = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="cosmic-canvas" aria-hidden="true" />;
}
