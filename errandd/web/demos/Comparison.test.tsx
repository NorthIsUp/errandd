import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Comparison } from "./Comparison";
import { CUSTOM_CARD_EXAMPLES } from "./customCardExamples";

test("comparison shows the original renderer beside assistant-ui with the same fixture", () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("http://localhost/demos/chat/compare?example=custom-cards"),
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: () => null },
    });
    const html = renderToString(<Comparison initialData={CUSTOM_CARD_EXAMPLES} />);
    expect(html).toContain("Errandd UX with assistant-ui");
    expect(html).toContain("aui-demo-thread");
    expect(html.match(/data-custom-card="routine"/g)?.length).toBe(1);
    expect(html).toContain("<iframe");
    expect(html).toContain("Synthetic custom-card example");
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else Reflect.deleteProperty(globalThis, "location");
    if (storageDescriptor) Object.defineProperty(globalThis, "sessionStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
