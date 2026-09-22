/** Serialize fixture values as UTF-8 data, never as executable JavaScript syntax. */
export function rendererFixtureData(value: string): string {
 const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
 return `JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${encoded}"), c => c.charCodeAt(0))))`;
}
