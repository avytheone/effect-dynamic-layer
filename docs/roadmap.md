# Roadmap: Seven `DynamicRuntime` Application Scenarios

**English** | [Русский](ru/roadmap.md)

Status: **planned**. The project owner approved this plan on September 11, 2026. All seven areas are part of future work, but none is considered complete yet: having the required core primitives does not prove that an application scenario is ready. Saving this plan does not start implementation. This document does not authorize changes in a production environment or publication of the package.

What has already been implemented and verified is documented separately in the [verification results](status.md) and [operational semantics](semantics.md). The original agreements for the experimental 0.1.0 release are in [HANDOFF-dynamic-layer.md](../HANDOFF-dynamic-layer.md). This plan continues them and does not reopen the already completed work list.

## Goal

Use real applications to verify that a service graph can change at runtime without manually reproducing the rules for resource ownership, generation changes, and resource release.

Working formulation: **dynamic service graphs with structured-concurrency guarantees, built on ordinary `Effect` and `Layer` values**.

A scenario is suitable for verification if a dependency change could cause a leak, access to an already closed resource, or continued operation by a stale generation. The goal is to simplify the application and strengthen its guarantees, not to reproduce every Cordis feature.

## Sequence and Single Source of Status

The first three areas are the easiest to demonstrate to a broad audience. The others are equally required, but verify different architectural boundaries. A wave establishes priority, not an artificial technical dependency: independent work within the same wave may proceed separately. Server integrations remain a separate scenario and are not implicitly included in the message-handler work.

| ID | Wave | Area | Primary outcome | Status |
|---|---|---|---|---|
| UC-01 | 1 | Composable UI without Cordis | Preserve the behavior of the real experimental UI after replacing its lifecycle-management mechanism | Planned |
| UC-02 | 2 | AI agent environment and MCP tools | Change tools, models, and connections dynamically while safely managing active calls | Planned |
| UC-03 | 3 | NATS message handlers | Verify cleanup order, interruption, failures, and shutdown | Planned |
| UC-04 | 4 | Server integrations | Change credentials, configuration, and capability branches | Planned |
| UC-05 | 4 | Independent sessions and client environments | Separate `DynamicRuntime` instances and correctly own shared resources | Planned |
| UC-06 | 4 | Extension registry | Reversibly register tools, commands, routes, and service providers | Planned |
| UC-07 | 5 | Devices, data streams, and local applications | Verify resource ownership outside web and AI applications | Planned |

During implementation, a row's status and checklist marks may be changed only after observable verification. Evidence and remaining limitations must be added to the corresponding scenario section or linked to an actual result. A second, competing status list must not be created.

## UC-01 — Composable UI Without Cordis

**Starting point:** the neighboring [experiment-cordis-nats-composable-ui](../../experiment-cordis-nats-composable-ui/README.md) project. Its experimental UI was verified separately, but the migration to `DynamicRuntime` has not been performed.

**Scenario:** independently connected HTTP modules, service discovery, state and events over NATS, Caddy, native HTMX, recursively nested UI regions, and two independent workspaces. Cordis currently wraps Effect's `ManagedRuntime` and its disposer for each UI instance. UI composition and protection against late responses reside in the shell.

**How to implement:**

1. Record the observable scenarios of the original UI as mandatory behavior-preservation conditions.
2. Align the Effect version: the original project currently uses rc.113, while the library uses rc.115. Before migration, verify the currently pinned versions and select one version for the evaluation.
3. Express UI-instance lifetimes through `DynamicRuntime` and scoped `Effect` resources. Remove Cordis completely from source code and dependencies without retaining a compatibility wrapper around the old interface.
4. Separate instance identity, DOM ownership, required service dependencies, and the availability of network actions. In the existing UI, evaluate separate `Tag` values for instances or another minimal solution; do not add support for multiple providers of one service in advance.
5. Preserve the HTTP and NATS protocols as well as native HTMX. Request cancellation and epoch checks may be removed only when the corresponding guarantee is genuinely provided another way. An XHR call outside managed `use` does not become managed automatically.
6. Verify the real browser scenario with HTTP modules, NATS, and Caddy, then compare resources and behavior with the original UI.

**Completion criteria:**

- [ ] A module and region that appear late connect in either order; a module unknown to the shell in advance does not require rebuilding the shell.
- [ ] Two workspaces are independent; a history module connected late receives the current context of its own instance, and events from one workspace do not affect the other.
- [ ] After content replacement and `hx-preserve`, the nested notes module retains the same instance, expected DOM, resources, and unsaved input.
- [ ] When a tree is removed, children are released before the parent; the neighboring workspace continues to operate.
- [ ] Late responses after a context change, unload, or reconnection do not modify the current UI.
- [ ] Partial capability unavailability and failure of the parent region's HTTP service do not block independent children.
- [ ] NATS reconnection, management-service and Caddy restarts, and a prolonged outage preserve the working UI and input; subscriptions, listeners, and instances are not duplicated.
- [ ] After the last service using the update subject disconnects, the subscription is released; unload, reconnection, and shell shutdown release all resources they own.
- [ ] Native HTMX methods, content swaps, out-of-band updates, headers, navigation and history, `multipart`, errors, and timeouts preserve the behavior documented in the original project's README.
- [ ] Cordis is removed; lifecycle states and cleanup order are observable; the shell does not acquire a second implementation of the library's management mechanism.

**Limitations:** `gate=false` stops the current generation and is not a replacement for an availability signal under which an editor should remain on the page. A parent DOM element does not necessarily provide a required service to a child. One `Tag` corresponds to one service provider within a `DynamicRuntime` instance. Browser compatibility must be confirmed with a real run; an ESM target build alone does not prove it.

## UC-02 — AI Agent Environment and MCP Tools

**Scenario:** a graph consisting of `Credentials → MCP Connection → Search Tool` and `Credentials → Model Client → Agent`; the agent uses a tool registry. At runtime, new MCP servers connect, tools are revoked, credentials or model configuration change, and sessions end while data streams and child Effect tasks are active.

**How to implement:**

1. Before creating the demonstration application, verify connection, invocation, streaming, and an available cancellation method against a real local MCP server.
2. Describe connections, tools, and the model client with ordinary `Effect` and `Layer` values, explicitly identifying dependencies and resource owners.
3. Execute tool calls through managed `use`, and model tool registration as a reversible scoped contribution. If needed, create a minimal application-level registry rather than waiting for a separate platform.
4. Implement availability changes, configuration replacement, and session shutdown; show states, `Cause`, and generation changes.
5. In the same scenario, show which manual lifecycle coordination the library replaces.

**Completion criteria:**

- [ ] Connecting an MCP server late activates the required tool and does not restart independent tools.
- [ ] After a confirmed disable, a new tool call is not admitted; an executing managed call receives an interruption.
- [ ] The connection remains open until dependent-service cleanup and active calls have completed.
- [ ] Replacing credentials or model configuration rebuilds only the affected branch and stops the old generation first.
- [ ] A startup failure is visible in state and `Cause` rather than being lost in a background `Promise`.
- [ ] Session shutdown releases data streams, scoped child Effect tasks, connections, and tool registrations.
- [ ] An external call that mutates data is not retried automatically after interruption or a generation change; an indeterminate result must not be described as a cancelled action.

**Limitations:** resource-lifetime management does not create an isolated environment or a permission system, and it does not prove cancellation of an external action. The agent model, tool-selection rules, and MCP protocol remain the responsibility of the application and adapters, not the library core.

## UC-03 — Replaceable NATS Message Handlers

**Scenario:** `Credentials → Broker Connection → Subscription → Handler`, `Database Pool → Handler`. At runtime, handlers connect, subscription configuration and handler implementation change, a client environment is disabled, or shutdown begins while a message is being processed.

**How to implement:**

1. Verify a real broker subscription and its cleanup. For a scenario using `ack` and `nack`, select a mode that actually supports these operations, such as NATS JetStream, and do not attribute them to Core NATS.
2. Describe the connection, subscription, handler, and pool as scoped `Effect` resources with explicit dependencies.
3. Model message processing as managed work and explicitly define application rules for interruption, `ack`, and `nack`.
4. Implement runtime connection, subscription changes, handler replacement, and `DynamicRuntime` shutdown.
5. Artificially delay handler cleanup and confirm that the connection it needs remains available until cleanup finishes.

**Completion criteria:**

- [ ] Stopping an owner leaves no active subscription or untracked handler behind.
- [ ] A handler does not access a closed pool; `nack` or lease release, when provided by the protocol, completes before the required connection closes.
- [ ] Changing one branch does not restart independent handlers.
- [ ] A resource-acquisition failure does not start endless reconnection attempts; an explicit `retry` permits one controlled attempt.
- [ ] Shutdown waits for active-processing cleanup rather than merely sending a stop signal.
- [ ] Redelivery, `ack`, `nack`, and handling of an indeterminate result follow explicitly selected application rules.

**Limitations:** `DynamicRuntime` does not provide exactly-once delivery, durable execution, or universal replay. Idempotency and broker delivery rules remain in the application. The current rule for managed `use` is to interrupt the work and wait for its cleanup, not necessarily to let every business operation complete successfully.

## UC-04 — Server Integrations with Changing Configuration

**Scenario:** `Configuration → Credentials → API Client → Integration` and an independent `Configuration → Database Pool → Reporting` branch. At runtime, credentials or a service address change, an integration is enabled for a client, or a paid capability is disabled—without restarting the entire process. This is an independent server scenario, not part of UC-03.

**How to implement:**

1. Select a real local HTTP integration and a resource-owning client; verify adapter acquisition, interruption, and resource release.
2. Separate configuration dependencies so that changing one integration does not affect the independent branch.
3. Describe service-descriptor replacement and scoped ownership of credentials and the client; perform active operations through managed `use`.
4. Implement credential changes, `enable`, `disable`, and handling of invalid new configuration with observable diagnostics.

**Completion criteria:**

- [ ] After revocation, the old generation admits no new operations.
- [ ] Old resources do not close until managed work and its cleanup have completed.
- [ ] When credentials change, the old generation stops first: the new client is not published until the old generation has completed in an allowed manner.
- [ ] A new-configuration failure is visible; an already closed old generation is not presented as automatically restored.
- [ ] Independent integrations and reporting continue to operate without restarting their generations.
- [ ] Toggling a capability or changing a service address does not require restarting the entire HTTP server; the observable period of unavailability follows the demonstration application's rules.

**Limitations:** seamless switching without any period of unavailability and successful completion of every old request are not promised. The application must allow interruption and temporary unavailability. Credentials must not appear in public state snapshots or logs.

## UC-05 — Independent Sessions and Client Environments

**Scenario:** multiple agent sessions, IDE projects, workspaces, or accounts for one API. The same logical `Tag` values, such as `Database` or `ModelClient`, receive different implementations and lifetimes in independent `DynamicRuntime` instances.

**How to implement:**

1. Create several concurrently running environments through the existing public interface.
2. Separate local resources from genuinely shared ones. For every shared resource, explicitly define its single owner and a way to use it without repeated acquisition and release.
3. Verify replacement and shutdown of one environment, distinguishability of instances in diagnostics, and repeated creation and removal cycles.
4. Record actual composition limitations before proposing new mechanisms for isolation, multiple providers of one service, or resource-scope hierarchies.

**Completion criteria:**

- [ ] Identical `Tag` values in independent `DynamicRuntime` instances do not mix implementations, states, or calls.
- [ ] Changing or closing one environment does not interrupt a neighboring environment.
- [ ] A shared resource is not reacquired unnecessarily and is not released by one consuming service while another remains alive.
- [ ] Diagnostics distinguish environment, registration, and generation without exposing credentials.
- [ ] Repeated creation and removal do not accumulate active subscriptions, Effect tasks, or resources from completed environments.
- [ ] The scenario is implemented with existing facilities, or a missing guarantee is identified and justified separately without secretly bypassing resource-ownership rules.

**Limitations:** Effect's `Scope` defines resource lifetime but is not equivalent to Cordis context isolation. Client environments do not protect against untrusted code. Multiple providers of one service should not be added merely to resemble another platform.

## UC-06 — Extension Registry and Reversible Registrations

**Scenario:** when a module connects, it adds tools, commands, HTTP routes, event handlers, menu items, adapters, or service providers. When the module stops, its contributions disappear while contributions from other modules remain.

**How to implement:**

1. Make the registry an ordinary application service. Explicitly define how contributions are distinguished, what happens when keys collide, and how a contribution is revoked.
2. During resource acquisition, use `Effect.acquireRelease` to register a contribution and obtain its revocation function, then call that function during release; the module itself must depend on the registry.
3. Implement late registrations, replacement, and owner unload; verify rollback after a partially completed connection.
4. Determine whether one approach is sufficient for the listed kinds of contributions without creating a separate platform for each one in advance.
5. Move a shared interface into the library only after multiple applications genuinely require the same substantial coordination.

**Completion criteria:**

- [ ] A contribution becomes visible after successful connection and is revoked when its owner finishes.
- [ ] A failure in the middle of connection leaves no ownerless registration.
- [ ] Reconnection or replacement does not create duplicates; key collisions are resolved by an explicitly defined rule.
- [ ] Unloading one owner does not remove another owner's contributions.
- [ ] Calls through a revoked contribution do not bypass managed-call admission checks; previously retained references are not automatically considered safe.
- [ ] The approach applies to tools, commands, routes, handlers, menu items, and service providers; the result lists the specific integrations and kinds of contributions actually verified.

**Limitations:** this starts as an application module, not as a promise of built-in events, middleware, a loader, hot module replacement, or a complete Cordis equivalent. The need for a shared abstraction is established through reuse, not through the number of interfaces imagined.

## UC-07 — Devices, Data Streams, and Local Applications

**Scenario:** `Audio Device → Capture Stream → Transcription → Consumer`. Other acceptable real platforms include a camera, serial port, file watcher, or WebSocket stream. The user changes the device, the device disconnects, a handler is replaced, or a project or window closes.

**How to implement:**

1. Select an available real source and verify opening it, stopping its stream, interruption, and release before creating the application.
2. Describe the source and handlers as scoped `Effect` resources. Keep adapter availability messages separate from the lifetime of local application state.
3. Implement source changes, handler replacement, and project or window closure without retaining untracked references to the resource.
4. Repeat connection and disconnection cycles, then check for late events after the resource is revoked.

**Completion criteria:**

- [ ] After its owner finishes, the device or descriptor is not left occupied and can be opened again.
- [ ] After the permitted stop barrier, the old stream does not deliver data to a dependent service that has already finished.
- [ ] Cleanup of a downstream dependent service completes before release of the upstream resource it requires.
- [ ] Changing a device or handler does not restart independent application branches.
- [ ] Closing a project or window releases its data streams, listeners, and scoped child Effect tasks.
- [ ] Non-cooperative shutdown is visible as delayed completion rather than being hidden by forcibly closing a resource under a still-running dependent service.

**Limitations:** automatic hardware-failure detection and the ability to interrupt an arbitrary driver are not part of the library—they are provided and verified by the adapter. The scenario does not promise hard real-time behavior or a particular latency.

## How to Implement and Verify Each Scenario

For each area:

1. Verify the risky real interface first: the source, driver, transport, interruption, and resource release. If access is unavailable, say so rather than replacing a real integration with a fake successful response.
2. Record the expected transitions, resource-ownership rules, permitted interruption behavior, and visible consequences of replacement.
3. Implement a minimal but complete application path using ordinary `Effect`, `Layer`, and the public `DynamicRuntime` interface. New core semantics may be proposed only for specific missing behavior.
4. Verify the real mode of use: a browser for a UI; a running process and real protocol for a server integration, message handler, and MCP; an available device or source for a local application.
5. Use controlled delays to verify material races: disabling during resource acquisition, a call, or cleanup; late operation completion; `replace`; and `shutdown`. Several successful happy-path runs do not prove correct ordering.
6. Preserve reproducible launch instructions, results, and limitations. Add permanent regression checks for genuine behavioral risks, not to increase the test count.
7. Update the row and checklist in this plan only after obtaining evidence, not after creating a scaffold. Do not claim compatibility with unverified runtimes or Effect versions.

## Conditions for Public Presentation

This is an evidence-gathering plan, not authorization to publish the package to npm or declare it production-ready.

- [ ] All seven areas have been implemented and verified against their criteria, or the owner has explicitly approved a scope change; no area has silently disappeared from the plan.
- [ ] The first three applications provide clear and reproducible examples: a UI without Cordis, an agent with MCP tools, and a replaceable message handler.
- [ ] Concrete examples show which manual coordination was removed and which guarantees replaced it; complexity has not merely moved into another application-level management mechanism.
- [ ] The “dependent service first, then provider” order and rejection of new calls to an old generation are confirmed by observable scenarios, not marketing claims.
- [ ] The table of verified runtimes and versions, launch instructions, and limitations is current; browsers, devices, and external protocols are described as supported only after real verification.
- [ ] It is explicitly documented that `DynamicRuntime` does not guarantee interruption of an external action, automatic replay, switching without a period of unavailability, DOM preservation, exactly-once delivery, or safety of arbitrary JavaScript.

Success means that the application knows less about races, generations, and resource-release order while retaining full control over its business rules.
