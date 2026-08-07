# GoodWidget Analytics Chart Components -- Spec (All 4 Remaining)

*Spec for: Pie/Donut Chart, Bar Chart, Line/Area Chart, Data Table*
*Target repo: GoodDollar/GoodWidget*
*Target branch: feat/analytics-components (rename from feat/analytics-component-scorecard-plan)*
*PR: #142 (same PR as Scorecard)*
*Task naming: analytics-chart-pie-donut, analytics-chart-bar, analytics-chart-line-area, analytics-chart-table*

---

## Shared Preamble (applies to ALL 4 components)

### Why these exist

Standardized chart components in GoodWidget packages/ui -- cross-platform building blocks that any widget can compose. These 4 components, combined with the already-built Scorecard, form the complete analytics visualization layer. They replace one-off HTML+Chart.js dashboards with reusable, consistent, theme-aware components.

### Technical constraints (non-negotiable)

- Must use **react-native-svg** for all graphical elements (Svg, Path, Rect, Circle, Line, G, Polygon, Polyline, Text)
- Must use **Tamagui primitives** from @goodwidget/ui (Stack, YStack, XStack, Text, Heading) for non-SVG layout
- Must use **useTheme()** for all colors -- zero hardcoded hex values
- Must use **createComponent()** for all internal styled sub-pieces (enables theme targeting)
- Must support all 3 GoodWidget pipelines: React web, React Native, Web Components
- Must use **formatMetricValue** from `packages/ui/src/utils/formatMetricValue.ts` for number formatting
- Must follow **Scorecard.tsx** component structure, spacing system, and type scale (use the same SCORECARD_BASE_SIZE_PX and GOLDEN_RATIO constants)
- Push changes to PR #142 branch (renamed to `feat/analytics-components`)
- **No animation.** Do NOT add react-native-reanimated or any animation library. No entrance animations, no transitions. Static rendering only.
- **No new dependencies.** react-native-svg is already a peerDependency. Do not add any new packages.

### Shared design system

**Type scale and spacing:** Follow Scorecard.tsx's established system exactly. Use its `SCORECARD_BASE_SIZE_PX` and `GOLDEN_RATIO` constants for all typography sizing and gap computation. Do NOT invent a separate spacing system -- derive from the same ratio so all analytics components breathe identically.

**Color palette for multi-category charts:**

```typescript
const CHART_COLOR_KEYS = ['primary', 'success', 'warning', 'colorDim', 'error'] as const
```

Resolved via `resolveThemeColor(theme, key)` at render time (same pattern as FundingDistributionChart). Always show direct labels (text) on every segment/bar/line -- never rely on color alone to convey information.

**Visual hierarchy rules:**
- Main data (values, primary metrics) visually dominates labels and chrome
- Labels/units use lighter weight and secondary color ($placeholderColor or $colorDim)
- SVG data elements (bars, line strokes, pie segments) are the heaviest visual elements
- Grid lines are the lightest (0.5-1px, $borderColor at reduced opacity)

### Design quality target

**Visual quality benchmark:** Nivo charts (https://nivo.rocks/). These are the aesthetic standard. Our components should look this polished in both light and dark themes.

**Specific aesthetic rules (measurable, not subjective):**

1. **Grid lines: nearly invisible.** strokeOpacity between 0.08 and 0.15. They orient the reader without competing with data. If you squint and the grid lines are the first thing you see, they're too strong.

2. **Axis labels: muted and small.** Use $placeholderColor (not $color). Font size at the smallest tier of the type scale. They exist to orient, not to inform.

3. **Data elements: saturated and bold.** Bars, line strokes, and pie segments use full-strength theme colors ($primary, $success, etc.) at 100% opacity. They are the hero.

4. **Area fills: vertical gradient, not flat.** When showArea=true, the fill should gradient from ~30% opacity at the line to ~5% opacity at the baseline. Use react-native-svg LinearGradient (Defs + LinearGradient + Stop elements). This is what makes area charts look premium vs flat/cheap.

5. **No borders on data shapes.** Bars and pie segments have fill only, no strokeWidth on the shape itself. (Pie uses strokeDasharray on a Circle for the arc technique -- that's different from a border.)

6. **Generous internal padding.** Chart content should breathe. The padding defaults ({ top: 16, right: 16, bottom: 40, left: 48 }) give axes room without cramping the data area.

7. **Title and metadata OUTSIDE the SVG.** Title, legend, description, trend badges -- all rendered as Tamagui Text/Heading ABOVE or BELOW the SVG element, not crammed inside it.

8. **Legend dots, not squares.** Legend color indicators are small circles (borderRadius full, 8x8 or 10x10), not squares. Consistent with FundingDistributionChart's existing 11x11 circles.

9. **Line charts: thin and precise.** Default strokeWidth=2. Not thick marker-style lines. Dots small (r=3) when shown. The line itself carries the information, not fat markers.

10. **Data glow on dark backgrounds (optional).** When the active theme is dark, primary-colored elements can have a very subtle shadow/glow effect (shadowColor matching the element color at 0.2-0.3 opacity, shadowRadius 4-8). On light themes, skip the glow -- it looks out of place. Match the glow pattern already used by GlowCard and ClaimActionGlow in the codebase.

**Card variant behavior:**
- `variant="bare"` (default): No wrapper, for embedding in existing layouts
- `variant="card"`: Wraps in existing Card primitive with elevation. DO NOT modify Card.ts.

**Accessibility baseline (every component):**
- Root SVG: `accessibilityRole="image"` + `accessibilityLabel` prop
- Decorative SVG elements (grid, axes, backgrounds): `accessible={false}`
- Cross-platform testID: both `testID={testID}` AND `data-testid={testID}` on root
- Minimum touch target for interactive elements: 44x44pt

**Integer formatting rule:**
```
IF value === Math.floor(value) THEN format without decimals
ELSE format with 1 decimal place
```

**NaN/Infinity guard:**
```
IF !Number.isFinite(value) THEN treat as 0, do not render that data point
```

### Scope boundary (HARD RULE)

For each component, ONLY create/modify:
1. `packages/ui/src/components/[ComponentName].tsx`
2. `packages/ui/src/index.ts` -- add export under `// Analytics` section
3. `examples/storybook/src/stories/design-system/[ComponentName].stories.tsx`
4. `tests/design-system/smoke.spec.ts` -- add test cases

**DO NOT touch:** Card.ts, Text.ts, Icon.tsx, theme.ts, presets.ts, config.ts, any file in packages/governance-widget/, package.json.

### Testing expectations

**Storybook story:** Default (bare), card variant, empty state, single data point, stress test (extreme data volume).

**Playwright smoke test:** Navigate to story, assert testID visible, screenshot, assert key text present.

---

## Component 1: Pie/Donut Chart

### Goal

A pie/donut chart component that displays categorical data as proportional arc segments. It generalizes the governance-widget's FundingDistributionChart into a reusable building block. An inner radius > 0 makes it a donut (with center metric); inner radius = 0 makes it a classic pie.

### When to use

**Best for:**
- Showing that parts sum to a meaningful whole (budget allocation, market share, chain distribution)
- 2-5 categories where the "100% total" message matters more than precise between-category comparison
- When one dominant category vs several smaller ones is the story (e.g., "Celo handles 70% of claims")
- Situations where the reader's question is "what fraction?" not "how much more?"

**Not appropriate for:**
- Comparing exact values between categories -- bar chart is far more accurate for this
- More than 7 categories -- aggregate or use a bar chart
- Showing change over time -- use stacked area or grouped bar
- Comparing two pie charts side by side -- nearly impossible to compare angles across separate charts
- Very similar-sized segments (e.g., three categories at ~33% each) -- bar chart shows differences much more clearly

### Visual reference

- **Aesthetic target:** Nivo Pie interactive demo (center metric, arc labels, legends, theming): https://nivo.rocks/pie/
- Existing codebase pattern: FundingDistributionChart.tsx in governance-widget (SVG arc technique)

### Props / API surface (MVP)

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| data | Array<{ label: string; value: number; color?: string }> | Yes | - | Category data (absolute values, not percentages) |
| title | string | No | undefined | Chart heading |
| innerRadius | number | No | 0.6 | Inner radius as fraction of outer (0 = pie, 0.6 = donut) |
| centerLabel | string | No | undefined | Top text inside donut hole |
| centerValue | string | number | No | undefined | Main metric in center |
| centerValueFormatter | (value: number) => string | No | formatMetricValue | Center value formatting |
| centerSubLabel | string | No | undefined | Bottom text in center |
| maxSlices | number | No | 7 | Segments beyond this aggregate into "Other" |
| otherLabel | string | No | "Other" | Aggregated remainder label |
| sort | 'descending' | 'ascending' | 'none' | No | 'descending' | Segment sort order |
| showLegend | boolean | No | true | Display legend below chart |
| showPercentages | boolean | No | true | Show percentage in legend items |
| onSegmentPress | (item, index) => void | No | undefined | Segment tap callback |
| variant | 'bare' | 'card' | No | 'bare' | Visual variant |
| testID | string | No | undefined | Testing identifier |
| accessibilityLabel | string | No | auto-generated | Screen reader description |
| width | number | No | 188 | SVG width |
| height | number | No | 188 | SVG height |

### Behavioral rules

1. **Segment rendering:** Circle elements with strokeDasharray/strokeDashoffset (same technique as FundingDistributionChart). strokeWidth = 20.

2. **Sort and start position:** Sorted descending by default. First segment starts at -90 degrees (12-o'clock) via G rotation="-90".

3. **Aggregation:** If data.length > maxSlices, smallest items merge into one "Other" segment using the last palette color.

4. **Percentage display:** percentage = (item.value / sum(all values)) * 100. Integers show no decimal (25%), non-integers show one (33.3%).

5. **Color assignment:** From CHART_COLOR_KEYS via useTheme(). Custom item.color overrides. Cycle if data exceeds palette length.

6. **Center metric:** Formatted by centerValueFormatter (default: formatMetricValue). Constrained to inner radius width to prevent overflow.

7. **Empty state:** Empty data OR all values 0: grey ring ($borderColor, 0.18 opacity), centerLabel or "No data", no legend.

8. **Legend:** Vertical stack below chart. Each row: color swatch + label + percentage text.

9. **NaN/null/negative filtering:** Silently excluded from rendering and total calculation.

### Mock data for testing/screenshots

```typescript
// 1. Standard (GoodDollar funding)
const funding = [
  { label: 'Education Hubs', value: 157500 },
  { label: 'Merchant Onboard', value: 112500 },
  { label: 'Dev Grants', value: 90000 },
  { label: 'Creator Fund', value: 90000 },
]

// 2. Single item
const single = [{ label: 'UBI Distribution', value: 1000000 }]

// 3. Two near-equal
const nearEqual = [{ label: 'Celo', value: 51 }, { label: 'Fuse', value: 49 }]

// 4. Empty
const empty: [] = []

// 5. STRESS TEST -- 100+ items (triggers maxSlices aggregation heavily)
const stress = Array.from({ length: 120 }, (_, i) => ({
  label: `Category ${i + 1}`,
  value: Math.floor(Math.random() * 10000) + 100,
}))
// Expected: with maxSlices=7, this produces 7 segments (top 6 + one massive "Other")
// Tests: legend overflow, color cycling, aggregation math, percentage rounding at tiny values
```

### Acceptance criteria

- [ ] Renders proportional arcs starting at 12-o'clock, sorted descending
- [ ] Center label, value, sublabel display (donut mode, innerRadius > 0)
- [ ] Pure pie renders when innerRadius=0 (no center content)
- [ ] Legend shows items with correct swatches and percentages
- [ ] maxSlices=7 with 120 items produces exactly 7 segments
- [ ] Integers: 25% (not 25.0%). Non-integers: 33.3% (not 33%)
- [ ] Empty state: grey ring + "No data"
- [ ] variant="card" wraps correctly
- [ ] testID + data-testid both present
- [ ] accessibilityRole="image" on Svg
- [ ] No hardcoded colors
- [ ] onSegmentPress fires correctly
- [ ] Stress test (120 items): renders without crash, legend does not overflow container

### Out of scope (future)

- Tooltip on hover (web)
- Labels on segments (outside with leader lines)
- Custom arc styling per segment
- Interactive legend (click to hide segment)
- Gradient fills

### DO NOT

- DO NOT copy FundingDistributionChart wholesale -- extract only the SVG arc technique
- DO NOT use Canvas or web-only APIs
- DO NOT use Icon.tsx (web-only DOM SVG)

---

## Component 2: Bar Chart

### Goal

A bar chart component for discrete categorical comparison. This is the highest-accuracy chart type for comparing values across categories (position on a common scale). Supports vertical and horizontal layouts.

### When to use

**Best for:**
- Comparing magnitudes across discrete categories (claims per chain, funding per house, monthly totals)
- Showing ranking or ordering (sorted bars make rank instantly visible)
- When the reader's question is "which is bigger?" or "by how much?"
- Discrete time periods where each period is a complete unit (monthly totals, quarterly results)
- Long category labels (horizontal mode)

**Not appropriate for:**
- Continuous time series with many points -- use line chart (bars become too narrow and lose readability)
- Part-to-whole relationships -- use pie/donut or 100% stacked bar
- Showing trends/velocity -- line chart communicates rate of change better via slope
- More than ~20 categories without scrolling or filtering

**Horizontal vs vertical decision:**
- Use vertical (default) for short category labels and up to ~12 categories
- Switch to horizontal when labels exceed ~10 characters (avoids rotated text)
- Switch to horizontal when comparing many categories (>8) -- horizontal bars scale better vertically

### Visual reference

- **Aesthetic target:** Nivo Bar interactive demo (clean fills, muted axes, generous padding): https://nivo.rocks/bar/

### Props / API surface (MVP)

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| data | Array<{ category: string; value: number }> | Yes | - | Bar data |
| title | string | No | undefined | Chart heading |
| layout | 'vertical' | 'horizontal' | No | 'vertical' | Bar orientation |
| showGrid | boolean | No | true | Show grid lines |
| showValueLabels | boolean | No | false | Display values on bars |
| valueFormatter | (value: number) => string | No | formatMetricValue | Value/axis formatting |
| xAxisLabel | string | No | undefined | X-axis title |
| yAxisLabel | string | No | undefined | Y-axis title |
| barCornerRadius | number | No | 0 | Rounded top corners |
| onBarPress | (item, index) => void | No | undefined | Bar tap callback |
| variant | 'bare' | 'card' | No | 'bare' | Visual variant |
| testID | string | No | undefined | Testing identifier |
| accessibilityLabel | string | No | auto-generated | Screen reader description |
| width | number | string | No | '100%' | Chart width |
| height | number | No | 200 | Chart height |
| padding | { top, right, bottom, left } | No | { 16, 16, 40, 48 } | Internal padding for axes |

### Behavioral rules

1. **Zero baseline:** Y-axis always INCLUDES zero. If all values are positive, axis starts at 0. If values include negatives, axis extends below 0 (diverging bars from zero line).

2. **Axis calculation:** Max = ceil(maxValue * 1.1) rounded to a "nice" number (multiples of 1/2/5/10/20/50/100/1K/etc.). ~5 tick marks at nice intervals.

3. **Bar sizing:** barWidth = (availableWidth / categoryCount) * 0.7. Gap = barWidth * 0.3.

4. **Color:** All bars use $primary (single series MVP).

5. **Value labels:** When enabled, display above bars (vertical) or right of bars (horizontal). Hide if bar height < 20px.

6. **Horizontal layout:** Axes swap. Categories on y-axis (left), values on x-axis (bottom).

7. **Grid lines:** Horizontal grid lines at each y-axis tick. 0.5px, $borderColor, dashed "3 3".

8. **Axis labels:** X-axis centered below bars. If label overflows bar width, truncate with ellipsis. Y-axis right-aligned, formatted with formatMetricValue.

9. **Empty state:** Show axes with zero line + "No data" centered.

10. **NaN/null filtering:** Items excluded silently.

### Mock data for testing/screenshots

```typescript
// 1. Standard (claims by chain)
const chains = [
  { category: 'Celo', value: 45200 },
  { category: 'Fuse', value: 32100 },
  { category: 'Ethereum', value: 8500 },
]

// 2. Horizontal with long labels
const houses = [
  { category: 'House of Alignment', value: 450000 },
  { category: 'House of Innovation', value: 320000 },
  { category: 'House of Community', value: 180000 },
]

// 3. Single bar
const single = [{ category: 'Total Claims', value: 85800 }]

// 4. Empty
const empty: [] = []

// 5. STRESS TEST -- 100+ categories
const stress = Array.from({ length: 150 }, (_, i) => ({
  category: `Wallet ${String(i + 1).padStart(3, '0')}`,
  value: Math.floor(Math.random() * 100000),
}))
// Expected: bars become extremely narrow (< 1px each), labels overlap/disappear
// Tests: layout doesn't crash, axis still renders, bars clip rather than overflow
// This reveals: need to handle overflow gracefully (either scroll or show only first N)
```

### Acceptance criteria

- [ ] Renders vertical bars with correct proportional heights
- [ ] Y-axis includes zero (positive data: starts at 0; mixed: extends below)
- [ ] Y-axis uses nice-number ticks
- [ ] X-axis labels centered under bars, truncated if overflow
- [ ] Grid lines render as subtle dashed lines
- [ ] Horizontal layout works with axes swapped
- [ ] Value labels appear when enabled, hide when bar < 20px
- [ ] Empty state renders correctly
- [ ] 150-item stress test: renders without crash
- [ ] variant="card" wraps correctly
- [ ] testID + data-testid present
- [ ] No hardcoded colors
- [ ] formatMetricValue used for axis/value labels
- [ ] onBarPress fires correctly

### Out of scope (future)

- Grouped bars (multiple series side-by-side)
- Stacked bars
- Reference/target lines
- Interactive sort
- Scrollable overflow for many categories
- 100%-stacked bars

### DO NOT

- DO NOT implement grouped or stacked bars -- single series only
- DO NOT add a secondary y-axis
- DO NOT add horizontal scroll (truncate/clip instead)
- DO NOT use Icon.tsx or web-only APIs

---

## Component 3: Line/Area Chart

### Goal

A line/area chart for time-series and continuous data visualization. The most complex of the 5 components. It communicates trends, velocity, and cumulative patterns. Area mode (shaded fill below line) emphasizes volume/accumulation.

### When to use

**Best for:**
- Showing trends over time (daily claims, member growth, reserve balance history)
- Communicating rate of change (slope = velocity -- "is it accelerating or slowing?")
- Comparing multiple time series on the same scale (up to 5 overlaid lines)
- Showing cumulative totals (area fill emphasizes "total so far")
- Identifying anomalies and pattern breaks in temporal data

**Not appropriate for:**
- Comparing exact values at a specific point -- bar chart or table is more accurate
- Categorical data with no natural ordering -- lines imply continuity between points
- More than 5-7 overlaid series -- becomes unreadable "spaghetti"
- When individual data points matter more than the connection between them -- use scatter plot

**Line vs area decision:**
- Use line when the trend/shape is the message
- Use area when cumulative volume or "total magnitude" is the message
- Use area when you want to emphasize "how much" over time, line when you want to emphasize "what direction"

### Visual reference

- **Aesthetic target:** Nivo Line interactive demo (multi-series, area fills, dots, clean grid): https://nivo.rocks/line/
- Nivo Area stacked example: https://nivo.rocks/stacked-area/

### Props / API surface (MVP)

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| data | Array<{ x: string | number; y: number; series?: string }> | Yes | - | Data points |
| title | string | No | undefined | Chart heading |
| series | Array<{ key: string; label: string; color?: string; strokeDasharray?: string }> | No | auto-detect | Series definitions |
| type | 'linear' | 'monotone' | 'step' | No | 'linear' | Interpolation curve |
| showArea | boolean | No | false | Fill area below line |
| areaOpacity | number | No | 0.15 | Area fill transparency (0-1) |
| showDots | boolean | 'auto' | No | 'auto' | Show point markers (auto = show if <20 points) |
| showGrid | boolean | No | true | Show grid lines |
| connectNulls | boolean | No | false | Bridge gaps in data (false = show visible gap) |
| strokeWidth | number | No | 2 | Line thickness |
| xAxisLabel | string | No | undefined | X-axis title |
| yAxisLabel | string | No | undefined | Y-axis title |
| xAxisFormatter | (value) => string | No | identity | X-axis label formatting |
| yAxisFormatter | (value) => string | No | formatMetricValue | Y-axis label formatting |
| yAxisDomain | [number | 'auto', number | 'auto'] | No | ['auto', 'auto'] | Y-axis range |
| secondaryYAxis | { key: string; label?: string; formatter?: (v) => string } | No | undefined | Secondary y-axis for a specific series |
| referenceLines | Array<{ value: number; label?: string; color?: string }> | No | [] | Horizontal marker lines |
| onPointPress | (point, seriesKey) => void | No | undefined | Point tap callback |
| variant | 'bare' | 'card' | No | 'bare' | Visual variant |
| testID | string | No | undefined | Testing identifier |
| accessibilityLabel | string | No | auto-generated | Screen reader description |
| width | number | string | No | '100%' | Chart width |
| height | number | No | 200 | Chart height |
| padding | { top, right, bottom, left } | No | { 16, 16, 40, 48 } | Internal padding |

### Behavioral rules

1. **Coordinate mapping:** X-values mapped to evenly-spaced positions. Y-values mapped linearly from domain to height (inverted: higher value = lower SVG y).

2. **Path generation:** 'linear' = straight segments (M, L). 'monotone' = monotone cubic Hermite spline (smooth, no overshoot). 'step' = hold value until next point (H then V).

3. **Area fill:** Duplicate line path, extend to bottom, close path. Fill with a **vertical LinearGradient** (react-native-svg Defs + LinearGradient + Stop): top Stop at series color with opacity 0.3, bottom Stop at series color with opacity 0.05. This gradient treatment is what distinguishes premium area charts from flat/cheap-looking fills.

4. **Multi-series:** Each series = separate Path with its own color. Layered in array order.

5. **Missing data (null y-values):** connectNulls=false (default): break path, visible gap. connectNulls=true: skip null, connect adjacent.

6. **Dots:** auto = show if fewer than 20 data points. Circle r=3, fill=series color.

7. **Axis:** Nice-number algorithm (same as bar). Y extends 10% beyond data range. X labels at regular intervals; skip every Nth if they would overlap.

8. **Grid:** Horizontal only, subtle dashed (same as bar chart).

9. **Reference lines:** Horizontal line at y-value + optional right-aligned label. 1px solid, custom color or $colorDim.

10. **Secondary y-axis:** When secondaryYAxis is provided, the specified series maps to a second y-axis on the RIGHT side of the chart with its own scale/domain/formatter. All other series use the left axis. Render the secondary axis labels on the right edge. Use the series color for the axis labels to associate them. NOTE: dual axes can mislead readers -- the consumer is responsible for appropriate use.

11. **Empty state:** Axes only + "No data" centered.

12. **Single data point:** Render only a dot.

### Mock data for testing/screenshots

```typescript
// 1. Single series (daily claims, 14 days)
const daily = [
  { x: 'Jul 24', y: 18200 }, { x: 'Jul 25', y: 19400 },
  { x: 'Jul 26', y: 17800 }, { x: 'Jul 27', y: 21000 },
  { x: 'Jul 28', y: 22500 }, { x: 'Jul 29', y: 20100 },
  { x: 'Jul 30', y: 23800 }, { x: 'Jul 31', y: 25200 },
  { x: 'Aug 1', y: 24100 }, { x: 'Aug 2', y: 26800 },
  { x: 'Aug 3', y: 28400 }, { x: 'Aug 4', y: 27200 },
  { x: 'Aug 5', y: 30100 }, { x: 'Aug 6', y: 31500 },
]
// title="Daily UBI Claims", showArea=true, referenceLines=[{value:25000, label:"Target"}]

// 2. Multi-series with secondary y-axis
const multiAxis = [
  { x: 'Jan', y: 12000, series: 'claims' },
  { x: 'Jan', y: 0.012, series: 'price' },
  { x: 'Feb', y: 14500, series: 'claims' },
  { x: 'Feb', y: 0.011, series: 'price' },
  // ... (7 months)
]
// secondaryYAxis={ key: 'price', label: 'G$ Price', formatter: (v) => `$${v}` }

// 3. With missing data (gap)
const withGap = [
  { x: 'Day 1', y: 100 }, { x: 'Day 2', y: 120 },
  { x: 'Day 3', y: null }, { x: 'Day 4', y: null },
  { x: 'Day 5', y: 150 }, { x: 'Day 6', y: 160 },
]

// 4. Empty
const empty: [] = []

// 5. STRESS TEST -- 1000+ data points (daily data for 3 years)
const stress = Array.from({ length: 1095 }, (_, i) => {
  const date = new Date(2024, 0, 1)
  date.setDate(date.getDate() + i)
  return {
    x: date.toISOString().slice(0, 10),
    y: 10000 + Math.floor(Math.random() * 5000) + i * 10,
  }
})
// Expected: line becomes very dense, individual points invisible
// Tests: SVG path doesn't crash, axis label thinning kicks in, performance is acceptable
// Reveals: might need downsampling strategy for paths with 1000+ points
```

### Acceptance criteria

- [ ] Renders line connecting data points proportionally
- [ ] Y-axis nice-number ticks with auto domain
- [ ] X-axis labels display without overlapping (adaptive thinning)
- [ ] Grid lines render correctly
- [ ] Area fill below line at correct opacity
- [ ] Multi-series with distinct colors and legend
- [ ] Null y-values create visible gap (connectNulls=false)
- [ ] Null y-values bridge (connectNulls=true)
- [ ] Dots show at auto threshold (< 20 points)
- [ ] Reference line at correct position with label
- [ ] Step interpolation produces staircase
- [ ] Monotone interpolation produces smooth curve
- [ ] Secondary y-axis renders on right with correct scale
- [ ] Empty state: axes + "No data"
- [ ] Single point: dot only
- [ ] 1000-point stress test: renders without crash or hang
- [ ] variant="card" works
- [ ] Accessibility attributes present
- [ ] No hardcoded colors

### Out of scope (future)

- Tooltip/crosshair on hover
- Brush/zoom for time range selection
- Stacked area
- Custom dot shapes per series
- Data downsampling algorithm (MVP renders all points as-is)
- Pan/scroll for long series
- Sparkline variant (no axes)

### DO NOT

- DO NOT use 'natural' or 'basis' interpolation (overshoot, implies non-existent values)
- DO NOT add entrance animations on path drawing
- DO NOT use web-only APIs (no requestAnimationFrame, no CSS transitions)

---

## Component 4: Data Table

### Goal

A data table for exact value display with typed columns, formatting, and sorting. The complement to visual charts -- providing precise value lookup (the task charts are worst at). Uses only Tamagui layout (no SVG).

### When to use

**Best for:**
- Exact value lookup ("what was Celo's claim count on Tuesday?")
- Multi-attribute comparison across entities (address + volume + tx count + date)
- When the reader needs to find a specific number, not perceive a pattern
- As a companion to any chart ("see the chart for the trend, switch to table for exact numbers")
- Sorted leaderboards, ranked lists, detailed breakdowns

**Not appropriate for:**
- Pattern/trend detection -- charts are far faster for seeing shapes
- Very few data points (< 3 rows) -- just write a sentence
- Very many rows (> 100 visible) without pagination/filter -- becomes overwhelming

### Visual reference

- Aesthetic reference: StatCell pattern in ai-credits-widget's CreditsManagementCard.tsx
- Layout reference: CreditsManagementCard stat grid (backgroundColor=$backgroundHover, borderRadius, padding)

### Props / API surface (MVP)

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| data | Array<Record<string, unknown>> | Yes | - | Row data |
| columns | Array<ColumnDef> | Yes | - | Column configuration |
| title | string | No | undefined | Table heading |
| striped | boolean | No | true | Alternating row backgrounds |
| compact | boolean | No | false | Reduced row padding |
| stickyHeader | boolean | No | true | Fixed header on scroll |
| maxHeight | number | No | undefined | Max height before scroll |
| defaultSort | { key: string; direction: 'asc' | 'desc' } | No | undefined | Initial sort |
| onSort | (key, direction) => void | No | undefined | Sort callback |
| emptyMessage | string | No | "No data" | Empty state text |
| onRowPress | (row, index) => void | No | undefined | Row tap callback |
| variant | 'bare' | 'card' | No | 'bare' | Visual variant |
| testID | string | No | undefined | Testing identifier |
| accessibilityLabel | string | No | auto-generated | Screen reader description |

**ColumnDef:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| key | string | Yes | - | Data field accessor |
| label | string | Yes | - | Header text |
| type | 'text' | 'number' | 'date' | 'currency' | No | 'text' | Formatting hint |
| align | 'left' | 'center' | 'right' | No | 'center' | Cell alignment |
| width | number | string | No | 'auto' | Column width |
| minWidth | number | No | 60 | Minimum width |
| formatter | (value, row) => string | No | type-based | Custom formatting |
| sortable | boolean | No | false | Enable column sorting |
| truncate | boolean | No | true | Truncate with ellipsis |

### Behavioral rules

1. **Column alignment:** Default is 'center' for all columns. Explicit `align` prop overrides.

2. **Default formatters by type:**
   - text: String(value), truncate if needed
   - number: formatMetricValue. Integers: no decimal.
   - date: Display as-is (consumer pre-formats)
   - currency: formatMetricValue with consumer-provided prefix

3. **Sorting:** Client-side when sortable=true. Tap header: ascending -> descending -> clear. Unicode arrow indicator. Default sort on first render.

4. **Striped rows:** Even rows: $backgroundHover. Odd: transparent. Header: fontWeight 700.

5. **Sticky header:** Remains fixed on vertical scroll.

6. **Horizontal overflow:** If columns exceed container width, enable horizontal ScrollView.

7. **Empty state:** Header row + single merged cell with emptyMessage.

8. **Null/undefined values:** Display "--" in the cell.

9. **Row press:** Tappable when onRowPress provided. Press feedback.

10. **Compact mode:** Reduced padding, smaller font.

### Mock data for testing/screenshots

```typescript
// 1. Multi-column (top wallets)
const wallets = [
  { address: '0x1a2b...', volume: 1234567, txCount: 847, lastActive: 'Aug 5' },
  { address: '0x3c4d...', volume: 892000, txCount: 623, lastActive: 'Aug 4' },
  { address: '0x5e6f...', volume: 445000, txCount: 312, lastActive: 'Aug 3' },
  { address: '0x7g8h...', volume: 128000, txCount: 95, lastActive: 'Aug 1' },
  { address: '0x9i0j...', volume: 45200, txCount: 42, lastActive: 'Jul 28' },
]

// 2. Compact metrics summary
const metrics = [
  { metric: 'Daily Claims', value: 31500, change: '+8.2%' },
  { metric: 'Active Wallets', value: 12400, change: '+3.1%' },
  { metric: 'Reserve Balance', value: 4500000, change: '-1.2%' },
]

// 3. Empty
const empty: [] = []

// 4. Single column
const names = [{ name: 'Education Hubs' }, { name: 'Merchant Onboard' }, { name: 'Dev Grants' }]

// 5. STRESS TEST -- 100+ rows with scroll
const stress = Array.from({ length: 150 }, (_, i) => ({
  rank: i + 1,
  address: `0x${i.toString(16).padStart(8, '0')}`,
  amount: Math.floor(Math.random() * 1000000),
  txCount: Math.floor(Math.random() * 500),
}))
// maxHeight=300. Tests: vertical scroll, sticky header, sort performance with many rows
```

### Acceptance criteria

- [ ] Renders header + data rows matching column definitions
- [ ] Default center alignment on all columns
- [ ] formatMetricValue applied to number/currency columns
- [ ] Integers: no decimal (312 not 312.0)
- [ ] Striped rows alternate backgrounds
- [ ] Sticky header visible during scroll
- [ ] Sort toggles asc/desc/none on header tap with arrow indicator
- [ ] Empty state: header + emptyMessage
- [ ] Null cells show "--"
- [ ] Horizontal scroll activates when needed
- [ ] Compact mode reduces padding/font
- [ ] Truncation: ellipsis on overflow
- [ ] 150-row stress test: renders, scrolls smoothly, sort works
- [ ] variant="card" works
- [ ] testID + data-testid present
- [ ] onRowPress fires correctly

### Out of scope (future)

- Column resizing
- Multi-column sort
- Search/filter
- Export CSV
- Frozen first column
- Pagination
- Virtualized rows for 1000+
- Expandable rows
- Responsive card layout at small breakpoints

### DO NOT

- DO NOT use SVG (pure Tamagui layout: YStack, XStack, Text, ScrollView)
- DO NOT add FlatList/VirtualizedList
- DO NOT use Icon.tsx for sort arrows -- use unicode characters
- DO NOT add pagination

---

## Appendix

### Branch rename

Rename PR #142 branch: `feat/analytics-component-scorecard-plan` -> `feat/analytics-components`

### Build order

Pie/Donut -> Bar -> Line/Area -> Table (simplest to most complex).

### File structure (final state)

```
packages/ui/src/components/PieDonutChart.tsx      (NEW)
packages/ui/src/components/BarChart.tsx            (NEW)
packages/ui/src/components/LineAreaChart.tsx       (NEW)
packages/ui/src/components/DataTable.tsx           (NEW)
packages/ui/src/index.ts                          (MODIFIED - add exports)
examples/storybook/src/stories/design-system/PieDonutChart.stories.tsx  (NEW)
examples/storybook/src/stories/design-system/BarChart.stories.tsx       (NEW)
examples/storybook/src/stories/design-system/LineAreaChart.stories.tsx   (NEW)
examples/storybook/src/stories/design-system/DataTable.stories.tsx      (NEW)
tests/design-system/smoke.spec.ts                  (MODIFIED - add cases)
```

### resolveThemeColor utility

FundingDistributionChart has `resolveThemeColor` in governance-widget/src/shared.tsx. Duplicate into each chart component or extract to packages/ui/src/utils/. Must have fallback to $color token.

### Screenshots required

After implementation, provide screenshots of bare and card variants for each component in dark theme.
