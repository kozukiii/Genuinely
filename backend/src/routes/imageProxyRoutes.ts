import { Router } from "express";
import { getSourceImage, ImageFetchError } from "../services/sourceImageCache";
import { diagnostic, failureKind, imageIdentity } from "../utils/analysisDiagnostics";

const router = Router();
router.get("/", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) return res.status(400).send("Missing URL");
  const startedAt = Date.now();
  let bytes = 0;
  let failure: string | undefined;
  res.once("finish", () => diagnostic("display_image_proxy", {
    ...imageIdentity(url), status: res.statusCode, bytes, elapsedMs: Date.now() - startedAt, failure,
  }));
  try {
    const image = await getSourceImage(url);
    bytes = image.buffer.length;
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(image.buffer);
  } catch (error: any) {
    failure = failureKind(error);
    if (error instanceof ImageFetchError) return res.status(error.status).send(error.message);
    const message = error?.message ?? "";
    if (/protocol|private address|host is not allowed|invalid url/i.test(message)) return res.status(400).send("Invalid image URL");
    if (/too many redirects|redirect missing location/i.test(message)) return res.status(502).send("Image redirect failed");
    return res.status(502).send("Image unavailable");
  }
});
export default router;
