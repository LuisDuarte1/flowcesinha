import {
	WorkflowStep,
	type WorkflowEvent,
	type WorkflowSleepDuration,
	type WorkflowStepConfig,
} from "cloudflare:workers";
import {
	Result,
	type ResultType,
	type StorageEngineBase,
} from "./storageEngines";
import type { ErrorReporterBase } from "./errorReporting";

export * from "./storageEngines";
export * from "./errorReporting";

export type FlowcesinhaOptions<
	T extends StorageEngineBase | undefined,
	ErrorReporter extends ErrorReporterBase | undefined,
> = {
	storageEngine?: T extends StorageEngineBase ? T : undefined;
	errorReporter?: ErrorReporter extends ErrorReporterBase
		? ErrorReporter
		: undefined;
	/**
	 * Note that this function will be called **after** the reversable functions are executed, but the errors from the reverse steps are not catched, yet.
	 *
	 * Because of a runtime limitation, stacktraces will be wrong in case of an Error
	 * @param error Probably an `Error` but exceptions can really be anything JS
	 * @returns
	 */
	globalFailureHandler?: (error: unknown) => Promise<void> | void;
};

const defaultStepConfig = {
	retries: {
		delay: "5 seconds",
		limit: 5,
		backoff: "exponential",
	},
	timeout: "10 minutes",
} satisfies WorkflowStepConfig;

interface FlowcesinhaContextConstructor<
	Env,
	Params,
	StorageEngine extends StorageEngineBase | undefined = undefined,
	ErrorReporter extends ErrorReporterBase | undefined = undefined,
> {
	ctx: ExecutionContext;
	env: Env;
	event: WorkflowEvent<Params>;
	step: WorkflowStep;
	workflowName: string;
	config?: FlowcesinhaOptions<StorageEngine, ErrorReporter>;
}

type Callback<
	T,
	Env,
	Params,
	StorageEngine extends StorageEngineBase | undefined,
	ErrorReporter extends ErrorReporterBase | undefined,
> = (
	event: WorkflowEvent<Params>,
	step: FlowcesinhaContextBase<Env, Params, StorageEngine, ErrorReporter>,
) => Promise<T>;

interface DurableFetchConfig extends WorkflowStepConfig {
	/**
	 * Defaults to true, will checkout the `Retry-After` header and retry the request after the specified time.
	 */
	followRetryAfter?: boolean | ((headers: Headers) => Date);
}

interface DurableMapConfig extends WorkflowStepConfig {
	/**
	 * The number of steps that can run concurrently. Defaults to Infinite (alias to Promise.all)
	 */
	maxConcurrency?: number;
}

export class FlowcesinhaContextBase<
	Env,
	Params,
	StorageEngine extends StorageEngineBase | undefined,
	ErrorReporter extends ErrorReporterBase | undefined,
> {
	private ctx: ExecutionContext;
	private env: Env;
	private event: WorkflowEvent<Params>;
	private step: WorkflowStep;
	private options: FlowcesinhaOptions<StorageEngine, ErrorReporter>;
	private instanceId: string;
	private workflowName: string;

	// The value is a tuple, where the first element is the reverse function and the second is the retry policy and the third is the data
	#reversableFunctions: Map<
		string,
		[(data: unknown) => Promise<void>, WorkflowStepConfig, unknown]
	> = new Map();

	#counters: Map<string, number> = new Map();

	#getCount(name: string): number {
		let val = this.#counters.get(name) ?? 0;
		// 1-indexed, as we're increasing the value before write
		val++;
		this.#counters.set(name, val);

		return val;
	}
	constructor(
		reqs: FlowcesinhaContextConstructor<
			Env,
			Params,
			StorageEngine,
			ErrorReporter
		>,
	) {
		this.ctx = reqs.ctx;
		this.env = reqs.env;
		this.event = reqs.event;
		this.step = reqs.step;
		this.options = reqs.config ?? {};
		this.instanceId = reqs.event.instanceId;
		this.workflowName = reqs.workflowName;
	}

	async run<T>(
		callback: Callback<T, Env, Params, StorageEngine, ErrorReporter>,
	): Promise<T> {
		//TODO(lduarte): o11y
		try {
			return await callback(this.event, this);
		} catch (e) {
			this.options.errorReporter?.reportError(e as Error, {
				instanceId: this.instanceId,
				workflowName: this.workflowName,
			});
			// execute reversable functions, if any
			await this.#executeReverseFunctions();

			// TODO(lduarte): should the failure handler be a list of errors because of the reversable functions? something to work out ig
			// execute global failure handler, if any
			await this.options.globalFailureHandler?.(e);

			throw e;
		}
	}

	/**
	 * This method is used to execute a step in the workflow, but with all the Flowcesinha goodies that you are using: Custom storage engines, o11y, etc.
	 *
	 * If you are using a custom storage engine, extra sub-requests will probably be made, so beware of that.
	 * @param name
	 * @param callback
	 */
	do<T extends Rpc.Serializable<T>>(
		name: string,
		callback: () => Promise<T>,
	): StorageEngine extends StorageEngineBase
		? Promise<Result<T, StorageEngine>>
		: Promise<T>;
	do<T extends Rpc.Serializable<T>>(
		name: string,
		config: WorkflowStepConfig,
		callback: () => Promise<T>,
	): StorageEngine extends StorageEngineBase
		? Promise<Result<T, StorageEngine>>
		: Promise<T>;
	async do<T extends Rpc.Serializable<T>>(
		name: string,
		configOrCallback: WorkflowStepConfig | (() => Promise<T>),
		callback?: () => Promise<T>,
	): Promise<unknown> {
		if (typeof configOrCallback === "function") {
			callback = configOrCallback;
			configOrCallback = defaultStepConfig;
		}

		// Implement the logic for the 'do' method here
		if (!callback) {
			throw new Error("Callback function is required");
		}
		const count = this.#getCount(name);

		if (this.options.storageEngine === undefined) {
			// TODO(lduarte): o11y and stuff
			callback = this.#callbackWithErrorReporting(callback, `${name}-${count}`);
			return this.#stepDoWithOptions(name, configOrCallback, callback);
		}

		const stableKey = `${this.workflowName}/${this.instanceId}:${name}-${count}`;
		callback = this.#callbackWithStorageEngine(
			callback,
			stableKey,
		) as unknown as () => Promise<T>;
		// we want to do error reporting **after** the storage engine callback, because the storage callback can fail.
		callback = this.#callbackWithErrorReporting(callback, `${name}-${count}`);

		const stableKeyResult = await this.#stepDoWithOptions(
			name,
			configOrCallback,
			callback as unknown as () => Promise<[string, ResultType]>,
		);
		return new Result(
			this.options.storageEngine,
			stableKeyResult[0],
			stableKeyResult[1],
		);
	}

	/**
	 * When we have error reporting, we want to have it inside the step.do too, because we probably want to report all errors, but with a differnt tag.
	 * When a error reporter is not defined, we return the normal callback.
	 * @returns
	 */
	#callbackWithErrorReporting<T>(callback: () => Promise<T>, stepName: string) {
		return this.options.errorReporter !== undefined
			? async () => {
					try {
						return await callback();
					} catch (e) {
						this.options.errorReporter?.reportError(e as Error, {
							instanceId: this.instanceId,
							workflowName: this.workflowName,
							stepName,
						});
						throw e;
					}
				}
			: callback;
	}

	async #stepDoWithOptions<T extends Rpc.Serializable<T>>(
		name: string,
		config: WorkflowStepConfig,
		callback: () => Promise<T>,
	): Promise<T> {
		// TODO: analytics

		// NOTE(lduarte): we intentionally don't do error reporting here, because we want to do it in the top-level `run` method.
		return await this.step.do(name, config, callback);
	}

	#callbackWithStorageEngine<T>(
		callback: () => Promise<T>,
		stableKey: string,
	): () => Promise<[string, ResultType]> {
		return async () => {
			const result = await callback();
			await this.options.storageEngine?.set(
				stableKey,
				result,
				result instanceof ArrayBuffer ? "arrayBuffer" : "json",
			);

			return [
				stableKey,
				result instanceof ArrayBuffer ? "arrayBuffer" : "json",
			];
		};
	}

	/**
	 * In case that you want to use the underlying native Workflows storage (in case you defined a storage engine, otherwise the behaviour is the same).
	 * Will still include all the o11y features that you are using.
	 * @param name
	 * @param callback
	 */
	nativeDo<T extends Rpc.Serializable<T>>(
		name: string,
		callback: () => Promise<T>,
	): Promise<T>;
	nativeDo<T extends Rpc.Serializable<T>>(
		name: string,
		config: WorkflowStepConfig,
		callback: () => Promise<T>,
	): Promise<T>;
	async nativeDo<T extends Rpc.Serializable<T>>(
		name: string,
		configOrCallback: WorkflowStepConfig | (() => Promise<T>),
		callback?: () => Promise<T>,
	): Promise<T> {
		if (typeof configOrCallback === "function") {
			callback = configOrCallback;
			configOrCallback = defaultStepConfig;
		}
		// Implement the logic for the 'do' method here
		if (!callback) {
			throw new Error("Callback function is required");
		}
		const count = this.#getCount(name);

		callback = this.#callbackWithErrorReporting(callback, `${name}-${count}`);

		return this.#stepDoWithOptions(name, configOrCallback, callback);
	}

	sleep(name: string, duration: WorkflowSleepDuration): Promise<void> {
		this.#getCount(name);
		return this.step.sleep(name, duration);
	}

	sleepUntil(name: string, timestamp: Date | number): Promise<void> {
		this.#getCount(name);
		return this.step.sleepUntil(name, timestamp);
	}

	/**
	 * `reversableDo` is a primitive that allows you to define a step that can be reversed in case that a workflows fails in the following steps.
	 * The retry policy will apply both to the do function and the reverse function.
	 *
	 * **NOTE**:`reversableDo` can take 2 steps in case of workflow failure, so
	 * make sure to account with that, for step limits.
	 *
	 * The reverse function will have the data (or the result if using a storage engine) as the first argument, so that you can know what to reverse.
	 *
	 * This is useful when you have a step like booking a flight, and you want to make sure that if the workflow fails, you can undo the booking.
	 * @param name of the step, in case of failure the reverse function will be called with the name `${name}-reverse`
	 * @param callback
	 * @param reverseCallback
	 */
	async reversableDo<T extends Rpc.Serializable<T>>(
		name: string,
		callback: () => Promise<T>,
		reverseCallback: (
			data: StorageEngine extends StorageEngineBase
				? Result<T, StorageEngine>
				: T,
		) => Promise<void>,
	): Promise<
		Awaited<
			StorageEngine extends StorageEngineBase
				? Promise<Result<T, StorageEngine>>
				: Promise<T>
		>
	>;
	async reversableDo<T extends Rpc.Serializable<T>>(
		name: string,
		config: WorkflowStepConfig,
		callback: () => Promise<T>,
		reverseCallback: (
			data: StorageEngine extends StorageEngineBase
				? Result<T, StorageEngine>
				: T,
		) => Promise<void>,
	): Promise<
		Awaited<
			StorageEngine extends StorageEngineBase
				? Promise<Result<T, StorageEngine>>
				: Promise<T>
		>
	>;
	async reversableDo<T extends Rpc.Serializable<T>>(
		name: string,
		configOrCallback: WorkflowStepConfig | (() => Promise<T>),
		callbackOrReverseCallback:
			| (() => Promise<T>)
			| ((
					data: StorageEngine extends StorageEngineBase
						? Result<T, StorageEngine>
						: T,
			  ) => Promise<void>),
		reverseCallback?: (data: T) => Promise<void>,
	): Promise<unknown> {
		if (typeof configOrCallback === "function") {
			reverseCallback = callbackOrReverseCallback as (data: T) => Promise<void>;
			callbackOrReverseCallback = configOrCallback;
			configOrCallback = defaultStepConfig;
		}

		if (!reverseCallback) {
			throw new Error("Reverse callback function is required");
		}

		const count = this.#getCount(name);
		const stepName = `${name}-${count}`;

		let callback = this.#callbackWithErrorReporting(
			callbackOrReverseCallback as () => Promise<T>,
			stepName,
		);

		if (this.options.storageEngine !== undefined) {
			const stableKey = `${this.workflowName}/${this.instanceId}:${stepName}`;
			callback = this.#callbackWithStorageEngine(
				callback,
				stableKey,
			) as unknown as () => Promise<T>;
		}

		const result = await this.#stepDoWithOptions(
			name,
			configOrCallback,
			callback,
		);

		if (this.options.storageEngine !== undefined) {
			const storageEngineResult = new Result(
				this.options.storageEngine,
				(result as unknown[])[0] as string,
				(result as unknown[])[1] as ResultType,
			);
			// cast data to unknown, because we the class is generic and we can't know the type of data that it stores
			this.#reversableFunctions.set(stepName, [
				reverseCallback as (data: unknown) => Promise<void>,
				configOrCallback,
				storageEngineResult,
			]);
			return storageEngineResult;
		}

		// cast data to unknown, because we the class is generic and we can't know the type of data that it stores
		this.#reversableFunctions.set(stepName, [
			reverseCallback as (data: unknown) => Promise<void>,
			configOrCallback,
			result,
		]);

		return result;
	}

	async #executeReverseFunctions() {
		for (const [stepName, [reverseCallback, config, data]] of this
			.#reversableFunctions) {
			const reverseStepName = `${stepName}-reverse`;
			const callback = this.#callbackWithErrorReporting(
				reverseCallback.bind(undefined, data),
				reverseStepName,
			);

			// NOTE(lduarte): even if the reverse step fails, we want to continue with the other reverse steps to clean up as much as possible
			try {
				await this.#stepDoWithOptions(reverseStepName, config, callback);
			} catch (e) {
				this.options.errorReporter?.reportError(e as Error, {
					instanceId: this.instanceId,
					workflowName: this.workflowName,
					stepName: reverseStepName,
				});
			}
		}
	}

	/**
	 * A "durable" fetch that will retry, and on status 429 or 503 it will respect the `Retry-After` header, if it exists. (unless specified not to). Useful to interact with other services
	 *
	 * **NOTE**: will use up to N steps (where N is the number of retries) in case of failure.
	 * @param input
	 * @param init
	 */
	async fetch(
		name: string,
		input: RequestInfo | URL,
		init?: RequestInit<RequestInitCfProperties> & DurableFetchConfig,
	): Promise<
		StorageEngine extends StorageEngineBase
			? Result<Response, StorageEngine>
			: Response
	> {
		const count = this.#getCount(name);
		const stepName = `${name}-${count}`;
		const followRetryAfter = init?.followRetryAfter ?? true;
		const config = {
			retries: {
				delay: init?.retries?.delay ?? defaultStepConfig.retries.delay,
				limit: init?.retries?.limit ?? defaultStepConfig.retries.limit,
				backoff: init?.retries?.backoff ?? defaultStepConfig.retries.backoff,
			},
			timeout: init?.timeout ?? defaultStepConfig.timeout,
		};

		// In this case, retries will be handled externally, because there's no native way to do this afaik
		// this means that we also have to do error reporting and storage by hand

		// typecast is necessary because typescript doesn't recognize that we are setting it to false in a async function - otherwise it would
		// throw a types are always disctinct error
		const fetchCallback = async () => {
			try {
				const response = await fetch(input, init);
				if (
					followRetryAfter &&
					[429, 503].includes(response.status)
				) {
					const retryAfter = response.headers.get("Retry-After");
					if (retryAfter) {
						const maybeInt = parseInt(retryAfter, 10);
						let retryAfterDate: Date;
						if (!isNaN(maybeInt)) {
							retryAfterDate = new Date(new Date().valueOf() + maybeInt * 1000);
						} else {
							// otherwise, we assume that we it returned the HTTP date format.
							// FIXME(lduarte): validate the HTTP date format beforing passing to date
							retryAfterDate = new Date(retryAfter);
						}
						return retryAfterDate;
					}
				}

				if (typeof followRetryAfter === "function") {
					const retryAfterDate = followRetryAfter(response.headers);
					return retryAfterDate;
				}

				if (!response.ok) {
					// there's a bug with try-catching steps so return undefined to signify an error
					return undefined;
				}

				if (this.options.storageEngine !== undefined) {
					const stableKey = `${this.workflowName}/${this.instanceId}:${stepName}`;
					await this.options.storageEngine.set(stableKey, response, "response");
					return stableKey;
				}

				const arrayBuffer = await response.arrayBuffer();
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					headers[key] = value;
				});
				return [
					arrayBuffer,
					{ status: response.status, response: response.statusText, headers },
				];
			} catch (e) {
				// we do error handling by hand
				this.options.errorReporter?.reportError(e as Error, {
					instanceId: this.instanceId,
					workflowName: this.workflowName,
					stepName,
				});
				return undefined;
			}
		};
		// don't retry because we are handling it ourselves
		let retryCount = 0;

		while (retryCount <= config.retries.limit) {
			const result = await this.#stepDoWithOptions(
				`${stepName}-${retryCount}`,
				{ ...config, retries: { ...config.retries, limit: 0 } },
				fetchCallback,
			);
			if (result instanceof Date) {
				retryCount++;
				await this.sleepUntil(`${stepName}-retry`, result);
				continue;
			} else if (result == undefined) {
				retryCount++;
				await this.sleep(`${stepName}-retry`, config.retries.delay);
				continue;
			}

			if (result !== undefined) {
				if (Array.isArray(result) && this.options.storageEngine === undefined) {
					// @ts-expect-error we always will return the right stuff here
					return new Response(result[0], result[1]);
				}
				if (
					typeof result === "string" &&
					this.options.storageEngine !== undefined
				) {
					// @ts-expect-error we always will return the right stuff here
					return new Result(this.options.storageEngine, result);
				}
				throw new Error(
					"This should never happen - fetch call result not handled",
				);
			}
		}

		throw new Error("Fetch failed after all retries");
	}

	/**
	 * `doMap` is syntactic sugar for mapping over a list and doing a step for each item. Retries and timeouts apply to each entry in the iterable.
	 *
	 * It will stop at the first step that errors out, throwing the same error.
	 *
	 * Also, the input iterable **MUST** be deterministic and have a finite length.
	 *
	 * It has the extra concurrency controls, so you can control how many steps are running at the same time (and avoid hitting workers limits for more heavy processing, at the cost of running time).
	 */
	async doMap<I, O extends Rpc.Serializable<O>>(
		baseName: string,
		list: I[],
		callback: (item: I) => Promise<O>,
	): Promise<
		StorageEngine extends StorageEngineBase ? Result<O, StorageEngine>[] : O[]
	>;
	async doMap<I, O extends Rpc.Serializable<O>>(
		baseName: string,
		list: I[],
		options: DurableMapConfig,
		callback: (item: I) => Promise<O>,
	): Promise<
		StorageEngine extends StorageEngineBase ? Result<O, StorageEngine>[] : O[]
	>;
	async doMap<I, O extends Rpc.Serializable<O>>(
		baseName: string,
		list: I[],
		configOrCallback: DurableMapConfig | ((item: I) => Promise<O>),
		callback?: (item: I) => Promise<O>,
	): Promise<
		StorageEngine extends StorageEngineBase ? Result<O, StorageEngine>[] : O[]
	> {
		if (typeof configOrCallback === "function") {
			callback = configOrCallback;
			configOrCallback = { ...defaultStepConfig };
		}
		const maxConcurrency = configOrCallback.maxConcurrency ?? Infinity;

		const stepConfig = {
			retries: {
				delay:
					configOrCallback.retries?.delay ?? defaultStepConfig.retries.delay,
				limit:
					configOrCallback.retries?.limit ?? defaultStepConfig.retries.limit,
				backoff:
					configOrCallback.retries?.backoff ??
					defaultStepConfig.retries.backoff,
			},
			timeout: configOrCallback.timeout ?? defaultStepConfig.timeout,
		} satisfies WorkflowStepConfig;

		if (!callback) {
			throw new Error("Callback function is required");
		}

		if (maxConcurrency <= 0) {
			throw new Error("maxConcurrency must be greater than 0");
		}

		if (maxConcurrency === Infinity) {
			const results = await Promise.all(
				list.map((item) =>
					this.do(baseName, stepConfig, callback.bind(undefined, item)),
				),
			);
			return results as unknown as StorageEngine extends StorageEngineBase
				? Result<O, StorageEngine>[]
				: O[];
		}

		// we assume unknown because it's difficult to do this type safe lmao
		const results: unknown[] = [];

		const mapPromise = new Promise((resolve, reject) => {
			const stepsToRun: (() => Promise<unknown>)[] = list.map((item) =>
				callback.bind(undefined, item),
			);

			const runStep = async (step: () => Promise<unknown>) => {
				this.do(baseName, stepConfig, step as () => Promise<O>)
					.then((result) => {
						results.push(result);
						const maybeStep = stepsToRun.shift();
						if (maybeStep === undefined) {
							if (results.length === list.length) {
								resolve(undefined);
							}
							return;
						}
						runStep(maybeStep);
					})
					.catch((e) => reject(e));
			};

			stepsToRun.splice(0, maxConcurrency).forEach((step) => runStep(step));
		});

		await mapPromise;

		return results as StorageEngine extends StorageEngineBase
			? Result<O, StorageEngine>[]
			: O[];
	}
}

export function useFlowcesinha<
	T,
	Env,
	Params,
	StorageEngine extends StorageEngineBase | undefined = undefined,
	ErrorReporter extends ErrorReporterBase | undefined = undefined,
>(
	params: FlowcesinhaContextConstructor<
		Env,
		Params,
		StorageEngine,
		ErrorReporter
	>,
	callback: Callback<T, Env, Params, StorageEngine, ErrorReporter>,
) {
	return new FlowcesinhaContextBase(params).run(callback);
}
