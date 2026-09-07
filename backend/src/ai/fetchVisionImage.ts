import { getSourceImage } from "../services/sourceImageCache";
import { diagnostic, failureKind, imageIdentity } from "../utils/analysisDiagnostics";

export async function fetchVisionImage(url: string): Promise<Buffer | null> {
  const startedAt = Date.now();
  try {
    const image = await getSourceImage(url);
    diagnostic("ebay_image_download", { ...imageIdentity(url), status: 200, bytes: image.buffer.length, outcome: "ok", elapsedMs: Date.now() - startedAt });
    return image.buffer;
  } catch (error: any) {
    diagnostic("ebay_image_download", { ...imageIdentity(url), status: error?.status ?? null, outcome: failureKind(error), elapsedMs: Date.now() - startedAt });
    return null;
  }
}
