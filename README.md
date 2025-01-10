# Flowcesinha - utility libraries for Cloudflare Workflows

Flowcesinha (pronunced `ˈfloʊsɨˈziɲɐ` - [paste it here to hear it](https://ipa-reader.com/)) is a **batteries included and zero-dependencies** library that empowers developers with powerful abstractions for [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

> [!WARNING]
> Flowcesinha is in a beta state, so use with care. Type breakages might (and probably will) happen.

Some notable features:

- **Custom storage engines** and **lazy step results** (R2 included) so that, you can store more state inside of an step (and you can bring your own storage engine!);
- **Error reporting** (Sentry provided in `flowcesinha-sentry`) and **Workflow failure handler**;
- **Reversable steps**: ability to add a revert callback in case that the workflow fails;
- **Durable fetch**: ability to fetch from APIs with dynamic retries (that come from the `Retry-After` header);
- **Functional primitives**: `doMap` (map but every call is done inside of a step);
- ... more to come soon!

## See it in action

Assume we are a travelling-agency and we want to make a Workflow that books a plane and a hotel:

```ts
type Env = {
	// Add your bindings here, e.g. Workers KV, D1, Workers AI, etc.
	MY_WORKFLOW: Workflow;
	R2_BUCKET: R2Bucket;
};
export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		return useFlowcesinha(
			{
				ctx: this.ctx,
				env: this.env,
				event,
				step,
				workflowName: this.constructor.name, // equivalent to writing "MyWorkflow"
				options: {
					storageEngine: new R2Storage(this.env.R2_BUCKET),
					errorReporter: new SentryErrorReporting({
						context: this.ctx,
						dsn: "YOUR-SENTRY-DSN",
					}),
					globalFailureHandler: (error) => {
						console.log("Workflow failed!", error);
					},
				},
			},
			async (event, step) => {
				// Because we are using a storage engine, everything that is a step is stored in it, which means that
				// we can store more than 1MiB of state per step
				const providersResp = await step.fetch(
					"Get providers for flight",
					"https://flight-searcher/providers",
				);

				const providers = await providersResp.json();

				const cheapestFlight = await step.do(
					"Choose cheapest flight",
					async () => {
						// assume that you have calculated the cheapest flight here
						return "LIS-LAX";
					},
				);

				await step.reversableDo(
					"Book flight",
					async () => {
						// assume that we have done some API call to the provider to reserve the flight
						return await cheapestFlight.getFull();
					},
					async () => {
						// if the workflow fails after this step, it will run this callback so that, you can cancel the flight booking
					},
				);

				await step.reversableDo(
					"Book hotel",
					async () => {
						// assume that we have done some API call to the provider to reserve the hotel
						return "Hilton";
					},
					async () => {
						// if the workflow fails after this step, it will run this callback so that, you can cancel the hotel booking
					},
				);

				return "finished";
			},
		);
	}
}
```

## Why is it called Flowcesinha?

Simply put, it's just derived from `Workflow + Francesinha = Flowcesinha`.

A [Francesinha](https://en.wikipedia.org/wiki/Francesinha) is a Portuguese sandwich, originally from Porto, that consists of many layers of all kinds of meats with melted cheese on top and most importantly a tomato-and-beer sauce (not with the sweet-like sauce, those don't count as real Francesinhas). These packages thrive to do the same, bring many good components together for a beautiful ~~gastronomic experience~~ developer experience.
