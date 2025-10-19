/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ZodType, z } from "zod";

export const ipgTokenResSchema = z.object({
  Status: z.number(),
  Accesstoken: z.string().optional(),
});

export const chargeApiPayloadSchema = z.object({
  amount: z.number(),
  payload: z.string(),
  invoiceId: z.string(),
  mobile: z
    .string()
    .trim()
    .min(11, { message: "mobile should be 11 digits!" })
    .max(11, { message: "mobile should be 11 digits!" })
    .regex(/((0?9)|(\+?989))\d{9}/g, { message: "mobile format is invalid!" }),
});

export const chargeApiResSchema = z.union([
  z.object({ error: z.string() }),
  z.object({ paymentURL: z.url() }),
]);

export const ipgAdviceResSchema = z.object({
  Status: z.string(),
  Message: z.string(),
  ReturnId: z.string(),
});

export const verifyApiPayloadSchema = z.object({
  invoiceid: z.string(),
  amount: z.coerce.number(),
  rrn: z.string().optional(),
  respcode: z.coerce.number(),
  respmsg: z.string().optional(),
  cardnumber: z.string().optional(),
  digitalreceipt: z.string().optional(),
  tracenumber: z.coerce.number().optional(),
});

export const sepehrAiVerifyPaymentPayloadSchema = z.object({
  ...verifyApiPayloadSchema.shape,
  ...ipgAdviceResSchema.shape,
});

export const sepehrAiVerifyPaymentResSchema = z.union([
  z.object({}),
  z.object({ error: z.string() }),
  z.object({
    error: z.string(),
    zodErrors: z.any(),
  }),
]);

// URL param keys should be all lowercase.
// I'm not sure why the browser magically makes the C in respCode lowercase automatically. Same for invoiceId.
export const sepehrAiPaymentResultPayloadSchema = z.union([
  z.object({
    status: z.string(),
    message: z.string(),
    returnid: z.string(),
    ...verifyApiPayloadSchema.shape,
    respcode: z.preprocess((val) => Number(val), z.literal(1)),
  }),
  z.object({
    message: z.string(),
    tracenumber: z.coerce.number().optional(),
    status: z.preprocess(
      (v) => String(v).toLowerCase(),
      z.union([z.literal("ok"), z.literal("nok"), z.literal("duplicate")]),
    ),
    respcode: z.preprocess(
      (val) => Number(val),
      z.union([z.literal(0), z.literal(-1), z.literal(-2)]),
    ),
  }),
]);

const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT || 10_000);
const DEFAULT_MAX_FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 5);

export interface SepehrFetchOptions<T> {
  body?: any;
  method?: string;
  schema?: ZodType<T>;
  headers?: HeadersInit;
  maximumRetries?: number;
  rep?: { code: (status: number) => void };
  onFetchFailure?: (e: unknown) => Promise<void>;
  errorLogger?: (obj: any, message: string) => void;
}

export type SepehrFetchResult<T> = [T, number, { error: string }?];

export const sepehrFetch = async function sepehrFetch<T>(
  url: string,
  options: SepehrFetchOptions<T>,
): Promise<SepehrFetchResult<T>> {
  if (!options.method) options.method = "POST";
  if (!options.errorLogger) {
    options.errorLogger = (obj, message) => console.error(message, obj);
  }
  if (!options.maximumRetries) {
    options.maximumRetries = DEFAULT_MAX_FETCH_RETRIES;
  }

  const {
    errorLogger,
    maximumRetries,
    method,
    body,
    onFetchFailure,
    schema,
    rep,
    headers,
  } = options;

  let lastError: unknown;
  let lastStatus: number = 0;
  let respBody: any = undefined;
  for (let i = 0; i < maximumRetries; i++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: method,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(headers ? headers : {}),
        },
      });
    } catch (error) {
      lastError = error;
      if (onFetchFailure) await onFetchFailure(error);
      errorLogger({ url, error, attempt: i + 1 }, "Fetch failed!");
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    lastStatus = response.status;

    try {
      let data: any = await response.json();
      if (!response.ok) {
        respBody = data;
        const msg = "Fetch status is not ok!";
        errorLogger({ url, response }, msg);
        throw new Error(msg);
      }

      if (schema) {
        const parseRes = await schema.safeParseAsync(data);
        if (!parseRes.success) {
          const msg = "Invalid response schema!";
          errorLogger({ url, data, parseRes }, "Invalid response schema!");
          throw new Error(msg);
        }

        data = parseRes.data;
      }

      return [data as T, lastStatus, undefined];
    } catch (error) {
      lastError = error;
      errorLogger({ url, error, attempt: i + 1 }, "Fetch data parsing failed!");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  errorLogger(
    { url, attempts: maximumRetries, lastError },
    "Fetch failed and maximum retry attempts reached!",
  );
  if (rep) rep.code(500);

  return [
    respBody,
    lastStatus,
    { error: "Fetch failed and maximum retry attempts reached!" },
  ];
};
