import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EffortSlider } from "./TraitsPicker";

const OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium", isDefault: true },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

describe("EffortSlider", () => {
  it("is one slider whose value is the selected level", () => {
    const markup = renderToStaticMarkup(
      <EffortSlider
        label="Effort"
        options={OPTIONS}
        value="high"
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('aria-valuemax="3"');
    expect(markup).toContain('aria-valuetext="High"');
    expect(markup).toContain("Faster");
    expect(markup).toContain("Smarter");
  });

  it("marks the provider's default as recommended", () => {
    const markup = renderToStaticMarkup(
      <EffortSlider
        label="Effort"
        options={OPTIONS}
        value="low"
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(markup).toContain("Recommended");
    expect(markup).toContain("left:clamp(1.75rem, 33.33333333333333%, calc(100% - 1.75rem))");
  });

  it("omits the recommendation when no level is the default", () => {
    const markup = renderToStaticMarkup(
      <EffortSlider
        label="Effort"
        options={OPTIONS.map(({ id, label }) => ({ id, label }))}
        value="low"
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(markup).not.toContain("Recommended");
  });
});
