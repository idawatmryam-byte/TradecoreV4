import {
  getGetTradeThesisQueryKey,
  useGetTradeThesis,
} from "@workspace/api-client-react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  LockKeyhole,
} from "lucide-react";
import { formatDate, formatNumber } from "@/lib/utils";

export interface PositionThesisCardProps {
  tradeId: number;
  currentStopLoss: number;
  remainingQuantity: number;
}

export function PositionThesisCard({
  tradeId,
  currentStopLoss,
  remainingQuantity,
}: PositionThesisCardProps) {
  const { data, isLoading, isError } = useGetTradeThesis(tradeId, {
    query: {
      refetchInterval: 10_000,
      queryKey: getGetTradeThesisQueryKey(tradeId),
    },
  });

  if (isLoading) {
    return (
      <Card data-testid="position-thesis-loading">
        <CardContent className="p-5 text-sm text-muted-foreground">
          Loading the immutable position thesis…
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card
        data-testid="position-thesis-error"
        className="border-destructive/40"
      >
        <CardContent className="flex items-start gap-2 p-5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          The thesis timeline is unavailable. Existing stop protection is
          unchanged; adaptive changes fail closed.
        </CardContent>
      </Card>
    );
  }

  const latest = data.events.at(-1);
  return (
    <Card data-testid="position-thesis-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-[15px]">
          <BrainCircuit className="h-4 w-4 text-primary" /> Position Thesis
          <Badge variant="outline">{data.thesis.managementPolicyVersion}</Badge>
          {latest && (
            <Badge
              variant={
                latest.thesisState === "DATA_UNCERTAIN"
                  ? "warning"
                  : latest.thesisState === "INVALIDATED"
                    ? "destructive"
                    : "secondary"
              }
            >
              {latest.thesisState}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-[13px]">
        <div className="grid gap-3 sm:grid-cols-2">
          <ThesisField label="Context" value={data.thesis.context} />
          <ThesisField label="Trigger" value={data.thesis.trigger} />
          <ThesisField
            label="Target rationale"
            value={data.thesis.targetRationale}
          />
          <ThesisField
            label="Expected duration"
            value={`${Math.round(data.thesis.expectedDurationSeconds / 60)} min · hard limit ${Math.round(data.thesis.maximumDurationSeconds / 60)} min`}
          />
        </div>
        <div className="rounded border bg-muted/20 p-3 font-mono text-xs">
          Entry {formatNumber(data.thesis.entry.price, 4)} · initial stop{" "}
          {formatNumber(data.thesis.entry.initialStopPrice, 4)} · target{" "}
          {formatNumber(data.thesis.entry.targetPrice, 4)}
        </div>
        <div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          aria-label="Current position thesis status"
        >
          <StatusField
            label="Current state"
            value={latest?.thesisState ?? "Awaiting evaluation"}
          />
          <StatusField
            label="Progress"
            value={
              latest
                ? `${latest.evaluation.progressR.toFixed(2)}R`
                : "Not evaluated"
            }
          />
          <StatusField
            label="Persisted protection"
            value={`Stop ${formatNumber(currentStopLoss, 4)} · qty ${formatNumber(remainingQuantity, 8)}`}
          />
          <StatusField
            label="Latest deterministic action"
            value={latest?.actionType ?? "Awaiting evaluation"}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Persisted protection is the required policy boundary. Broker-side
          confirmation remains subject to the execution reconciliation status.
        </p>
        {latest && latest.evaluation.contraryEvidence.length > 0 && (
          <div className="rounded border border-warning/40 bg-warning/5 p-3">
            <div className="mb-1 font-semibold">Contrary evidence</div>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {latest.evaluation.contraryEvidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <LockKeyhole className="h-3.5 w-3.5" /> Invalidation
          </div>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {data.thesis.invalidationConditions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div data-testid="position-thesis-timeline">
          <div className="mb-2 font-semibold">Management timeline</div>
          {data.events.length === 0 ? (
            <p className="rounded border border-dashed p-3 text-muted-foreground">
              No management evaluation has been recorded yet.
            </p>
          ) : (
            <ol className="space-y-2 border-l pl-4">
              {data.events.map((event) => (
                <li
                  key={event.eventId}
                  className="relative rounded border bg-background p-3"
                >
                  <CheckCircle2 className="absolute -left-[25px] top-3 h-4 w-4 bg-background text-primary" />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        event.stage === "FAILED" || event.stage === "REFUSED"
                          ? "destructive"
                          : event.stage === "SHADOW"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {event.stage}
                    </Badge>
                    <span className="font-semibold">{event.actionType}</span>
                    <span className="text-muted-foreground">
                      {event.thesisState}
                    </span>
                    <time className="ml-auto text-xs text-muted-foreground">
                      {formatDate(event.observedAt)}
                    </time>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {event.action.reasonCodes.join(" · ")}
                  </p>
                  <p className="mt-1 font-mono text-xs">
                    risk {event.validation.currentMaximumLoss.toFixed(4)} →{" "}
                    {event.validation.proposedMaximumLoss.toFixed(4)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ThesisField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-semibold">{label}</div>
      <p className="mt-1 leading-relaxed text-muted-foreground">{value}</p>
    </div>
  );
}

function StatusField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-3">
      <div className="text-xs font-semibold text-muted-foreground">{label}</div>
      <p className="mt-1 font-mono text-xs">{value}</p>
    </div>
  );
}
