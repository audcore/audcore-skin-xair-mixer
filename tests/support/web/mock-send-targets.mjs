import { channelSendTargets, outputSendTargets } from "./send-targets.mjs";
import { sendLabel } from "./send-label.mjs";

// Existing graph bindings only. Live device and extension discovery stays in host.
export function mockSendTargets(graph, sourceId, t = text => text, sidechains = []) {
  const source = graph?.chains?.find(chain => chain.id === sourceId);
  const result = outputSendTargets(graph, source).map(({ output_channel, ...target }) => ({
    ...target,
    label: sendLabel({ ...target, output_channel }, { graph }, t),
    ...(output_channel == null ? {} : { output_channel })
  }));
  return [...result, ...channelSendTargets(graph, sourceId, new Set(sidechains), t)];
}
