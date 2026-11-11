/** Minimal Prometheus text-format metrics (counters, gauges, histograms). No dependencies. */
type Labels = Record<string, string | number>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ""} ${v}`);
    return lines.join("\n");
  }
}

class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    private read: () => number,
  ) {}
  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} ${this.read()}`;
  }
}

class Histogram {
  private series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private bounds: number[],
  ) {}
  observe(labels: Labels, value: number) {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.bounds.forEach((b, i) => value <= b && s.buckets[i]++);
    s.sum += value;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const base = k ? `${k},` : "";
      this.bounds.forEach((b, i) =>
        lines.push(`${this.name}_bucket{${base}le="${b}"} ${s.buckets[i]}`),
      );
      lines.push(`${this.name}_bucket{${base}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ""} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ""} ${s.count}`);
    }
    return lines.join("\n");
  }
}

export class Metrics {
  private started = Date.now();
  readonly requests = new Counter("fp_http_requests_total", "HTTP requests by route and status.");
  readonly requestDuration = new Histogram(
    "fp_http_request_duration_seconds",
    "HTTP request duration.",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  );
  readonly jobs = new Counter("fp_jobs_total", "Background jobs by kind and outcome.");
  readonly jobDuration = new Histogram(
    "fp_job_duration_seconds",
    "Background job duration.",
    [0.01, 0.05, 0.25, 1, 5, 30, 120, 600, 1800],
  );
  readonly webhooks = new Counter("fp_webhooks_total", "Inbound webhooks by provider and result.");
  readonly tenantLoads = new Counter("fp_tenant_loads_total", "Workspace state loads by kind.");
  readonly sseClients = { value: 0 };
  private gauges = [
    new Gauge("fp_sse_clients", "Open live-update streams.", () => this.sseClients.value),
    new Gauge("fp_uptime_seconds", "Process uptime.", () => (Date.now() - this.started) / 1000),
  ];

  render(): string {
    return (
      [
        this.requests,
        this.requestDuration,
        this.jobs,
        this.jobDuration,
        this.webhooks,
        this.tenantLoads,
        ...this.gauges,
      ]
        .map((m) => m.render())
        .join("\n\n") + "\n"
    );
  }
}
