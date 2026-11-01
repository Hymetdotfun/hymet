import { it, expect } from "vitest";
import { defaults, validate } from "../lib/config";
import { socialLinks } from "../lib/socials";
const valid = { ...defaults, name: "Social token", symbol: "SOC" };
it("allows all three URLs to be empty or individually omitted by the user", () => {
  expect(() => validate(valid)).not.toThrow();
  for (const links of [
    { website: "https://example.com" },
    { twitter: "https://x.com/project" },
    { telegram: "https://t.me/project" },
  ])
    expect(() => validate({ ...valid, ...links })).not.toThrow();
  expect(socialLinks({})).toEqual({ website: "", twitter: "", telegram: "", social: "" });
  expect(socialLinks({ website: " ", twitter: "", telegram: "" })).toEqual({
    website: "",
    twitter: "",
    telegram: "",
    social: "",
  });
});
it.each([
  "https://x.com/project",
  "https://twitter.com/project",
  "https://www.x.com/project",
  "https://www.twitter.com/project",
])("accepts valid X/Twitter link %s", (twitter) =>
  expect(() => validate({ ...valid, twitter })).not.toThrow(),
);
it.each([
  "https://example.com",
  "https://www.example.org/about?source=token",
  "https://my-project.co.uk",
  "https://xn--bcher-kva.de",
])("accepts HTTPS website domains %s", (website) =>
  expect(() => validate({ ...valid, website })).not.toThrow(),
);
it.each([
  "https://t.me/project",
  "https://t.me/+inviteCode",
  "https://www.t.me/project",
])("accepts Telegram link %s", (telegram) =>
  expect(() => validate({ ...valid, telegram })).not.toThrow(),
);
it.each([
  "not a url",
  "http://example.com",
  "javascript:alert(1)",
  "data:text/html,test",
  "file:///tmp/test",
  "ftp://example.com",
  "https:example.com",
  "https://",
  "https://bad_domain.com",
  "https://-bad.com",
  "https://example",
  "https://127.0.0.1",
  "https://[::1]",
  "https://localhost",
  "https://service.local",
  "https://user:password@example.com",
  "https://example.com\\@evil.com",
  "https://example.com/white space",
  "https://example.com/\npath",
])("rejects malformed or unsafe website URL %s", (website) =>
  expect(() => validate({ ...valid, website })).toThrow(),
);
it.each([
  { twitter: "https://x.com.evil.com/project" },
  { twitter: "https://x.com@evil.com/project" },
  { twitter: "https://example.com/project" },
  { telegram: "https://t.me.evil.com/project" },
  { telegram: "https://example.com/project" },
  { telegram: "tg://resolve?domain=project" },
])("rejects a misleading social destination %j", (links) =>
  expect(() => validate({ ...valid, ...links })).toThrow(),
);
