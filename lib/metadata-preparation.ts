export function metadataPreparationError(
  error: unknown,
  authorization = false,
) {
  const message =
    error instanceof Error ? error.message : "Metadata preparation failed";
  if (authorization && /reject|4001/i.test(message))
    return "Launch approval rejected in Phantom. Nothing was uploaded and no automatic retry was requested.";
  return message;
}
export async function uploadAuthorizedMetadata(
  form: FormData,
  fetcher: typeof fetch = fetch,
) {
  let response: Response;
  try {
    response = await fetcher("/api/metadata", { method: "POST", body: form });
  } catch {
    throw Error(
      "Metadata service request failed in transport; upload completion UNKNOWN. Do not re-upload until existing Pinata records are checked. No automatic retry was attempted.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(
      `Metadata service returned an unreadable response (HTTP ${response.status}); upload completion UNKNOWN. Check existing pins before re-uploading.`,
    );
  }
  if (!response.ok) {
    const uri =
      typeof data.uri === "string" && data.uri.length <= 200
        ? data.uri
        : undefined;
    const request =
      typeof data.request === "string" && /^[0-9a-f-]{36}$/i.test(data.request)
        ? ` Request ${data.request}.`
        : "";
    throw Error(
      `Metadata service HTTP ${response.status}: ${typeof data.error === "string" ? data.error : "request failed"}.${request} ${uri ? `Pinata confirmed metadata upload. Existing URI: ${uri}. Public verification is incomplete; do not re-upload.` : "Upload completion is not established by this error; check existing Pinata records before retrying."}`,
    );
  }
  if (typeof data.uri !== "string" || typeof data.imageUrl !== "string")
    throw Error(
      "Metadata service response is incomplete; do not re-upload until existing pins are checked.",
    );
  return data as { uri: string; imageUrl: string };
}
