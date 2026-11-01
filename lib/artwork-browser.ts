export const ARTWORK_SIZE = 500;
export const ARTWORK_MAX_BYTES = 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

export function centeredCrop(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
    throw Error("Artwork image has invalid dimensions.");
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(Error("Artwork could not be compressed.")), type, quality);
  });
}

/** Center-crop and normalize the selected artwork before it reaches the upload form. */
export async function processArtwork(file: File) {
  if (!ACCEPTED_TYPES.has(file.type))
    throw Error("Choose a PNG, JPEG or GIF image.");
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw Error("Choose a non-empty image smaller than 20 MB to process.");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw Error("Artwork file is invalid or could not be decoded.");
  }
  try {
    if (bitmap.width > 16000 || bitmap.height > 16000)
      throw Error("Artwork dimensions are too large to process safely.");
    const crop = centeredCrop(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = ARTWORK_SIZE;
    canvas.height = ARTWORK_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw Error("Artwork processing is unavailable in this browser.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, ARTWORK_SIZE, ARTWORK_SIZE);

    let blob = await canvasBlob(canvas, "image/png");
    let extension = "png";
    if (blob.size > ARTWORK_MAX_BYTES) {
      // Flatten transparency to the HYMET near-black canvas color only when a
      // PNG cannot meet the upload limit; opaque PNGs remain lossless when small.
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#050807";
      context.fillRect(0, 0, ARTWORK_SIZE, ARTWORK_SIZE);
      for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
        blob = await canvasBlob(canvas, "image/jpeg", quality);
        if (blob.size <= ARTWORK_MAX_BYTES) break;
      }
      extension = "jpg";
    }
    if (blob.size > ARTWORK_MAX_BYTES)
      throw Error("This image cannot be compressed below the 1 MB upload limit. Choose a simpler image.");
    const basename = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "token-artwork";
    return new File([blob], `${basename}-500x500.${extension}`, { type: blob.type, lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}
