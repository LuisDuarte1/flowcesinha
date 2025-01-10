/* eslint-disable @typescript-eslint/no-unused-vars */
import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { R2Storage, useFlowcesinha } from 'flowcesinha';

type Env = {
	// Add your bindings here, e.g. Workers KV, D1, Workers AI, etc.
	MY_WORKFLOW: Workflow;
	WORKFLOWS_BUCKET: R2Bucket;
};

// User-defined params passed to your workflow
type Params = {
	email: string;
	metadata: Record<string, string>;
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
				config: {
					// Add your custom storage engine here
					storageEngine: new R2Storage(this.env.WORKFLOWS_BUCKET),
				},
			},
			async (event, step) => {
				// type of result is not the string directly, but a Result<string, StorageEngine>, which makes result fetching lazy.
				const result = await step.do("i'm a step", async () => {
					// more than 1MiB - which is the limit on the underlying storage
					return 'aaaa'.repeat(1024 * 1024 * 3);
				});

				// Making step results lazy let you to do heavier processing workflows since you can
				// only load the when actually needed (and when you don't need it, it will get GCed automatically) even inside of a step
				// using one of two ways:

				// get a stream of the result (in case that it is too big for the worker to handle at once)
				const resultStream = await result.getBlob();

				// or, get the full result in the same type as the original result inside of the do function (in this case, a string)
				const actualResult = await result.getFull();

				return 'finished';
			},
		);
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname.startsWith('/favicon')) {
			return Response.json({}, { status: 404 });
		}

		// Get the status of an existing instance, if provided
		const id = url.searchParams.get('instanceId');
		if (id) {
			const instance = await env.MY_WORKFLOW.get(id);
			return Response.json({
				status: await instance.status(),
			});
		}

		// Spawn a new instance and return the ID and status
		const instance = await env.MY_WORKFLOW.create();
		return Response.json({
			id: instance.id,
			details: await instance.status(),
		});
	},
};
