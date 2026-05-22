import { pageStyles } from "./styles";
import { pageScript } from "./script";
import { shellHtml } from "./sections/shell";
import { homeHtml } from "./sections/home";
import { chatsHtml } from "./sections/chats";
import { jobsHtml } from "./sections/jobs";
import { settingsHtml } from "./sections/settings";

function decodeUnicodeEscapes(text: string): string {
  const decodedCodePoints = text.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
  });
  return decodedCodePoints.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });
}

export function htmlPage(): string {
  // Build the shell HTML with section bodies injected
  const shellWithSections = shellHtml
    .replace('<section class="section section-active" id="section-home"></section>', `<section class="section section-active" id="section-home">${homeHtml}</section>`)
    .replace('<section class="section" id="section-chats" hidden></section>', `<section class="section" id="section-chats" hidden>${chatsHtml}</section>`)
    .replace('<section class="section" id="section-jobs" hidden></section>', `<section class="section" id="section-jobs" hidden>${jobsHtml}</section>`)
    .replace('<section class="section" id="section-settings" hidden></section>', `<section class="section" id="section-settings" hidden>${settingsHtml}</section>`);

  const html = String.raw`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClaudeClaw</title>
  <link rel="icon" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🦞</text></svg>' />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500&family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
${pageStyles}
  </style>
</head>
<body>
${shellWithSections}
  <script>
${pageScript}
  </script>
</body>
</html>`;
  return decodeUnicodeEscapes(html);
}
