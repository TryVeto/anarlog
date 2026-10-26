import { generatePath } from "@lisse/core";
import { useMemo, useState, type CSSProperties } from "react";

import { useMountEffect } from "@anlg/ui/hooks/use-mount-effect";
import {
  AVATAR_RASTER_SIZE,
  avatarFallbackGradient,
  avatarInitials,
  avatarRecipeKey,
  createAvatarPixels,
  type AvatarRecipe,
  type AvatarRenderStyle,
} from "@anlg/ui/lib/avatar";
import { controlSquircle } from "@anlg/ui/lib/squircle";

export type { AvatarRenderStyle } from "@anlg/ui/lib/avatar";

export type AvatarProps = Readonly<{
  seed: string;
  label?: string;
  size?: number;
  colorCount?: number;
  sphereCount?: number;
  dither?: number;
  renderStyle?: AvatarRenderStyle;
  imageUrl?: string | null;
  className?: string;
}>;

const imageCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 512;

export function Avatar({
  seed,
  label = seed,
  size = 40,
  colorCount = 4,
  sphereCount = 4,
  dither = 0.3,
  renderStyle = "dithered",
  imageUrl,
  className,
}: AvatarProps) {
  const recipe = { seed, colorCount, sphereCount, dither, renderStyle };
  const cacheKey = avatarRecipeKey(recipe);

  return (
    <AvatarImage
      key={`${cacheKey}|${imageUrl ?? ""}`}
      cacheKey={cacheKey}
      className={className}
      imageUrl={imageUrl}
      label={label}
      recipe={recipe}
      size={size}
    />
  );
}

function AvatarImage({
  cacheKey,
  className,
  imageUrl,
  label,
  recipe,
  size,
}: {
  cacheKey: string;
  className?: string;
  imageUrl?: string | null;
  label: string;
  recipe: AvatarRecipe;
  size: number;
}) {
  const [src, setSrc] = useState<string | undefined>(() =>
    imageCache.get(cacheKey),
  );
  const [imageFailed, setImageFailed] = useState(false);
  const dimension = Math.max(1, size);
  // Fixed-size avatars need no DOM measurements or per-avatar SVG effects.
  const outline = useMemo(
    () => generatePath(dimension, dimension, controlSquircle),
    [dimension],
  );
  const containerStyle = {
    width: dimension,
    height: dimension,
    display: "inline-flex",
    position: "relative",
    flexShrink: 0,
    filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.08))",
  } satisfies CSSProperties;
  const initialsStyle = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "white",
    fontSize: Math.max(7, dimension * 0.38),
    fontWeight: 600,
    lineHeight: 1,
    letterSpacing: "-0.04em",
    mixBlendMode: "overlay",
  } satisfies CSSProperties;
  const providerImageUrl = imageFailed ? null : imageUrl;
  const displayedImageUrl = providerImageUrl ?? src;

  useMountEffect(() => {
    const cached = imageCache.get(cacheKey);
    if (cached) {
      imageCache.delete(cacheKey);
      imageCache.set(cacheKey, cached);
      setSrc(cached);
      return;
    }
    if (!canRenderAvatarPng()) return;

    const timeout = window.setTimeout(() => {
      setSrc(renderAvatarPng(recipe));
    }, 0);
    return () => window.clearTimeout(timeout);
  });

  return (
    <span aria-hidden="true" className={className} style={containerStyle}>
      <span
        style={{
          position: "absolute",
          inset: 0,
          clipPath: `path('${outline}')`,
          background: avatarFallbackGradient(recipe.seed),
        }}
      >
        {displayedImageUrl ? (
          <img
            alt=""
            draggable={false}
            src={displayedImageUrl}
            onError={providerImageUrl ? () => setImageFailed(true) : undefined}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : null}
        {!providerImageUrl && (
          <span aria-hidden="true" style={initialsStyle}>
            {avatarInitials(label)}
          </span>
        )}
        <svg
          width={dimension}
          height={dimension}
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <path
            d={outline}
            fill="none"
            stroke="rgb(0 0 0 / 0.1)"
            strokeWidth={2}
          />
        </svg>
      </span>
    </span>
  );
}

function renderAvatarPng(recipe: AvatarRecipe): string | undefined {
  const key = avatarRecipeKey(recipe);
  const cached = imageCache.get(key);
  if (cached) {
    imageCache.delete(key);
    imageCache.set(key, cached);
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_RASTER_SIZE;
  canvas.height = AVATAR_RASTER_SIZE;

  try {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return undefined;

    const image = context.createImageData(
      AVATAR_RASTER_SIZE,
      AVATAR_RASTER_SIZE,
    );
    image.data.set(createAvatarPixels(recipe));

    context.putImageData(image, 0, 0);
    const url = canvas.toDataURL("image/png");
    imageCache.set(key, url);
    if (imageCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = imageCache.keys().next().value;
      if (oldestKey) imageCache.delete(oldestKey);
    }
    return url;
  } catch {
    return undefined;
  }
}

function canRenderAvatarPng(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof CanvasRenderingContext2D !== "undefined"
  );
}
