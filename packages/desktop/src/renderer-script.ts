/** A data literal for renderer scripts, safe in JavaScript and HTML contexts. */
export const rendererString = (value: string): string => JSON.stringify(value).replace(
  /[<>&\u2028\u2029]/g,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
);
