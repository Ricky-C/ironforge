import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { Logger } from "@aws-lambda-powertools/logger";
import { z } from "zod";

const logger = new Logger({ serviceName: "cost-reporter" });

const env = z
  .object({
    SNS_TOPIC_ARN: z.string().min(1),
  })
  .parse(process.env);

const ceClient = new CostExplorerClient({});
const snsClient = new SNSClient({});

const CostExplorerResponseSchema = z.object({
  ResultsByTime: z
    .array(
      z.object({
        Groups: z
          .array(
            z.object({
              Keys: z.array(z.string()).optional(),
              Metrics: z
                .object({
                  BlendedCost: z
                    .object({
                      Amount: z.string(),
                      Unit: z.string(),
                    })
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

type CostExplorerResponse = z.infer<typeof CostExplorerResponseSchema>;

export type ServiceCost = {
  service: string;
  amount: number;
  unit: string;
};

export const handler = async (): Promise<void> => {
  const { start, end } = yesterdayDateRange();
  logger.info("Fetching cost data", { start, end });

  const raw = await ceClient.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: "DAILY",
      Metrics: ["BlendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    }),
  );

  const validated = CostExplorerResponseSchema.parse(raw);
  const services = parseCostResponse(validated);
  const message = formatReport(services, start);

  await snsClient.send(
    new PublishCommand({
      TopicArn: env.SNS_TOPIC_ARN,
      Subject: `Ironforge daily cost report — ${start}`,
      Message: message,
    }),
  );

  logger.info("Daily cost report published", { serviceCount: services.length });
};

export function yesterdayDateRange(): { start: string; end: string } {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 1);

  return {
    start: formatDate(yesterday),
    end: formatDate(today),
  };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseCostResponse(result: CostExplorerResponse): ServiceCost[] {
  const groups = result.ResultsByTime?.[0]?.Groups ?? [];

  return groups
    .map((g) => ({
      service: g.Keys?.[0] ?? "Unknown",
      amount: Number.parseFloat(g.Metrics?.BlendedCost?.Amount ?? "0"),
      unit: g.Metrics?.BlendedCost?.Unit ?? "USD",
    }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

export function formatReport(services: ServiceCost[], date: string): string {
  const total = services.reduce((sum, s) => sum + s.amount, 0);
  const unit = services[0]?.unit ?? "USD";

  const lines: string[] = [
    `Ironforge daily cost report — ${date}`,
    "",
    `Total: ${formatMoney(total, unit)}`,
    "",
  ];

  if (services.length === 0) {
    lines.push("No spend recorded for this date.");
  } else {
    lines.push("By service:");
    for (const s of services) {
      lines.push(`  ${s.service}: ${formatMoney(s.amount, s.unit)}`);
    }
  }

  return lines.join("\n");
}

function formatMoney(amount: number, unit: string): string {
  if (unit === "USD") {
    return `$${amount.toFixed(2)}`;
  }
  return `${amount.toFixed(2)} ${unit}`;
}
