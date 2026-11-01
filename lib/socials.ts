export type SocialLinks = {
  website: string;
  twitter: string;
  telegram: string;
  social: string;
};

export function socialLinks(values: Partial<SocialLinks>): SocialLinks {
  const result: SocialLinks = { website: "", twitter: "", telegram: "", social: "" };
  for (const key of ["website", "twitter", "telegram", "social"] as const) {
    const value = (values[key] ?? "").trim();
    if (!value) continue;
    const label = {
      website: "Website",
      twitter: "X (Twitter)",
      telegram: "Telegram",
      social: "Additional social",
    }[key];
    let url: URL;
    try {
      if (!/^https:\/\//i.test(value) || /[\s\\]/.test(value)) throw Error();
      url = new URL(value);
    } catch {
      throw Error(`${label} URL must be a valid HTTPS URL`);
    }
    const labels = url.hostname.split(".");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hostname.length > 253 ||
      labels.length < 2 ||
      labels.some(
        (part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part),
      ) ||
      !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i.test(labels.at(-1)!) ||
      /(?:^|\.)(?:localhost|local)$/.test(url.hostname)
    )
      throw Error(
        `${label} URL must use HTTPS and a valid domain without credentials`,
      );
    if (
      key === "twitter" &&
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        url.hostname,
      )
    )
      throw Error("X (Twitter) URL must use x.com or twitter.com");
    if (key === "telegram" && !["t.me", "www.t.me"].includes(url.hostname))
      throw Error("Telegram URL must use t.me");
    result[key] = value;
  }
  return result;
}
