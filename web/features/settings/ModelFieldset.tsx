import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from "@pikoloo/darwin-ui";
import { useId } from "react";
import { Field } from "../../components/Field";

interface Props {
  model: string;
  fallback: string;
  onModelChange: (v: string) => void;
  onFallbackChange: (v: string) => void;
}

export function ModelFieldset({
  model,
  fallback,
  onModelChange,
  onFallbackChange,
}: Props) {
  const baseId = useId();
  const modelId = `${baseId}-model`;
  const fallbackId = `${baseId}-fallback`;

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Model</CardTitle>
      </CardHeader>
      <CardContent>
        <Field label="Primary Model" htmlFor={modelId}>
          <Input
            id={modelId}
            type="text"
            value={model}
            onChange={(e) => {
              onModelChange(e.target.value);
            }}
            placeholder="e.g. claude-sonnet-4-5"
          />
        </Field>
        <Field label="Fallback Model" htmlFor={fallbackId}>
          <Input
            id={fallbackId}
            type="text"
            value={fallback}
            onChange={(e) => {
              onFallbackChange(e.target.value);
            }}
            placeholder="e.g. claude-haiku-3-5"
          />
        </Field>
      </CardContent>
    </Card>
  );
}
