export function externalUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
