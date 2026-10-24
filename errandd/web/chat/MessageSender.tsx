import { Dog, Github, TriangleAlert, UserRound, Webhook } from "lucide-react";
import { useState } from "react";
import { actorIcon } from "./actorIcons";
import type { HookOrigin } from "../../shared/hookOrigin";

const providers = {
  github: { label: "GitHub", Icon: Github },
  datadog: { label: "Datadog", Icon: Dog },
  sentry: { label: "Sentry", Icon: TriangleAlert },
  webhook: { label: "Webhook", Icon: Webhook },
};
export function HookOriginIcon({ provider }: { provider: HookOrigin["provider"] }) {
  const { label, Icon } = providers[provider];
  const [failed, setFailed] = useState(false);
  const account =
    provider === "datadog" ? "datadog-official" : provider === "sentry" ? "sentry" : undefined;
  const image = account ? actorIcon({ provider, author: account }) : null;
  return (
    <span className="aui-origin-icon" role="img" aria-label={`${label} webhook`} title={label}>
      {image && !failed ? (
        <img
          src={image.url}
          alt=""
          width={16}
          height={16}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon size={16} aria-hidden="true" />
      )}
    </span>
  );
}
function CommenterAvatar({ origin }: { origin: HookOrigin }) {
  const [failed, setFailed] = useState(false);
  const image = actorIcon(origin);
  if (image && !failed)
    return (
      <img
        className="aui-commenter-avatar"
        src={image.url}
        title={image.label}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  return (
    <span className="aui-commenter-avatar" aria-hidden="true">
      <UserRound size={15} />
    </span>
  );
}
export function MessageSender({ origin }: { origin: HookOrigin }) {
  return (
    <header className="aui-message-sender" aria-label="Message sender">
      {origin.author && (
        <>
          <CommenterAvatar key={`${origin.provider}:${origin.author}`} origin={origin} />
          <strong>{origin.author}</strong>
        </>
      )}
      <HookOriginIcon provider={origin.provider} />
      <span className="aui-sender-detail">
        {providers[origin.provider].label}
        {origin.event ? ` · ${origin.event}` : ""}
        {origin.action ? ` · ${origin.action}` : ""}
      </span>
    </header>
  );
}
