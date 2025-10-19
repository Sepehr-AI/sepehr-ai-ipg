/* eslint-disable @typescript-eslint/no-explicit-any */
import fastifyFormbody from "@fastify/formbody";
import dotenv from "dotenv";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodType, z } from "zod";
import type { $ZodFlattenedError } from "zod/v4/core";

import {
  chargeApiPayloadSchema,
  chargeApiResSchema,
  ipgAdviceResSchema,
  ipgTokenResSchema,
  sepehrAiPaymentResultPayloadSchema,
  sepehrAiVerifyPaymentPayloadSchema,
  sepehrAiVerifyPaymentResSchema,
  sepehrFetch,
  verifyApiPayloadSchema,
} from "./lib.ts";

dotenv.config();
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormbody);

const IPG_TERMINAL_ID = process.env.IPG_TERMINAL_ID as string;
const IPG_CALLBACK_URL = process.env.IPG_CALLBACK_URL as string;
if (
  !IPG_TERMINAL_ID ||
  !IPG_CALLBACK_URL ||
  IPG_TERMINAL_ID.length !== 8 ||
  !IPG_CALLBACK_URL.length
) {
  fastify.log.error({ IPG_TERMINAL_ID, IPG_CALLBACK_URL });
  throw new Error(
    "Invalid IPG_TERMINAL_ID and IPG_CALLBACK_URL environment variables!",
  );
}

const parsePayload = async <T>(
  rep: FastifyReply,
  payload: any,
  schema: ZodType<T, any>,
): Promise<
  [T, { error: string; zodErrors: $ZodFlattenedError<T, string> }?]
> => {
  const parseResult = await schema.safeParseAsync(payload);
  if (!parseResult.success) {
    rep.code(400);
    return [
      undefined as unknown as any,
      {
        error: "Invalid payload!",
        zodErrors: parseResult.error.flatten(),
      },
    ];
  }

  return [parseResult.data, undefined];
};

function convertValuesToStrings(obj: Record<any, any>): Record<any, string> {
  const stringObj: any = {};
  for (const key in obj) {
    if (
      obj.hasOwnProperty(key) &&
      // Intentional.
      typeof obj[key] !== "undefined" &&
      obj[key] !== null &&
      obj[key] !== "undefined" &&
      obj[key] !== "null"
    ) {
      stringObj[key] = String(obj[key]);
    }
  }

  return stringObj;
}

fastify.post(
  "/charge",
  async (
    req: FastifyRequest<{ Body: unknown }>,
    rep: FastifyReply,
  ): Promise<z.infer<typeof chargeApiResSchema>> => {
    if (req.ip !== "127.0.0.1" && req.ip !== "::1") {
      rep.code(403);
      return { error: "Forbidden!" };
    }

    const [paymentPayload, paymentPayloadError] = await parsePayload(
      rep,
      req.body,
      chargeApiPayloadSchema,
    );
    if (paymentPayloadError) return paymentPayloadError;

    const [tokenData, , tokenError] = await sepehrFetch(
      "https://sepehr.shaparak.ir/Rest/V1/PeymentApi/GetToken",
      {
        rep,
        schema: ipgTokenResSchema,
        errorLogger: (obj, message) => rep.log.error(obj, message),
        body: {
          TerminalID: IPG_TERMINAL_ID,
          callbackURL: IPG_CALLBACK_URL,
          Amount: paymentPayload.amount,
          payload: paymentPayload.payload,
          CellNumber: paymentPayload.mobile,
          InvoiceID: paymentPayload.invoiceId,
        },
      },
    );
    if (tokenError) return tokenError;

    if (tokenData.Status !== 0 || !tokenData.Accesstoken) {
      rep.log.error({ tokenData }, "Token request failed!");
      return { error: "Token request failed!" };
    }

    const paymentURL = `https://sepehr.shaparak.ir/Pay?token=${encodeURIComponent(
      tokenData.Accesstoken,
    )}&terminalID=${encodeURIComponent(IPG_TERMINAL_ID)}`;

    return { paymentURL };
  },
);

const rollbackPayment = async (
  rep: FastifyReply,
  errorLogger: (obj: any, msg: string) => void,
  digitalreceipt: string | undefined,
) => {
  if (typeof digitalreceipt !== "string" || !digitalreceipt.length) return;

  try {
    await sepehrFetch("https://sepehr.shaparak.ir/Rest/V1/PeymentApi/Advice", {
      rep,
      errorLogger,
      body: {
        digitalreceipt,
        Tid: IPG_TERMINAL_ID,
      },
    });
  } catch (e) {
    errorLogger({ e, digitalreceipt }, "Failed to rollback payment!");
  }
};

const redirectToPaymentResult = (
  rep: FastifyReply,
  redirectSearchParams: z.infer<typeof sepehrAiPaymentResultPayloadSchema>,
) =>
  rep.redirect(
    `https://sepehr-ai.com/payment-callback?${new URLSearchParams(convertValuesToStrings(redirectSearchParams)).toString()}`,
    302,
  );

fastify.post(
  "/verify",
  async (req: FastifyRequest<{ Body: unknown }>, rep: FastifyReply) => {
    const [paymentPayload, paymentPayloadError] = await parsePayload(
      rep,
      req.body,
      verifyApiPayloadSchema,
    );
    if (paymentPayloadError) return paymentPayloadError;

    const [adviceData, , adviceError] = await sepehrFetch(
      "https://sepehr.shaparak.ir/Rest/V1/PeymentApi/Advice",
      {
        rep,
        schema: ipgAdviceResSchema,
        errorLogger: (obj, message) => rep.log.error(obj, message),
        body: {
          Tid: IPG_TERMINAL_ID,
          digitalreceipt: paymentPayload.digitalreceipt,
        },
      },
    );
    if (adviceError) {
      rep.log.error(
        { adviceData, adviceError, paymentPayload },
        "Failed to call the advice method!",
      );

      return redirectToPaymentResult(rep, {
        respcode: -1,
        status: "nok",
        message: "عدم امکان تایید تراکنش (خطای داخلی)",
      });
    }

    const [sepehrVerifyData, sepehrVerifyStatus, sepehrVerifyError] =
      await sepehrFetch("http://localhost:4050/api/verify-payment", {
        rep,
        schema: sepehrAiVerifyPaymentResSchema,
        errorLogger: (obj, message) => rep.log.error(obj, message),
        body: {
          ...paymentPayload,
          ...adviceData,
        } as z.infer<typeof sepehrAiVerifyPaymentPayloadSchema>,
      });
    if (sepehrVerifyStatus === 402 || sepehrVerifyStatus === 404) {
      await rollbackPayment(
        rep,
        (obj, message) => rep.log.error(obj, message),
        paymentPayload.digitalreceipt,
      );

      rep.log.error(
        {
          sepehrVerifyData,
          sepehrVerifyError,
          sepehrVerifyStatus,
        },
        "Sepehr verify 4xx error!",
      );

      return redirectToPaymentResult(rep, {
        respcode: -1,
        status: "nok",
        message:
          sepehrVerifyStatus === 402
            ? "برابر نبودن مبلغ تراکنش با مبلغ تعیین شده"
            : "تراکنش یافت نشد",
      });
    }
    if (sepehrVerifyError) {
      await rollbackPayment(
        rep,
        (obj, message) => rep.log.error(obj, message),
        paymentPayload.digitalreceipt,
      );

      rep.log.error(
        {
          sepehrVerifyData,
          sepehrVerifyError,
        },
        "Failed to verify!",
      );

      return redirectToPaymentResult(rep, {
        ...(paymentPayload as any),
        status: adviceData.Status,
        message: adviceData.Message,
        returnid: adviceData.ReturnId,
      });
    }

    return redirectToPaymentResult(rep, {
      message: adviceData.Message,
      tracenumber: paymentPayload.tracenumber,
      respcode: paymentPayload.respcode as 0 | -1 | -2,
      status: adviceData.Status as "ok" | "nok" | "duplicate",
    });
  },
);

try {
  const port = process.env.PORT || 4040;
  await fastify.listen({ port: Number(port), host: "0.0.0.0" });
  fastify.log.info(`Server listening on port ${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

process.on("uncaughtException", (error: Error) => {
  fastify.log.error(
    `Unhandled exception: ${error}\nException origin: ${error.stack}`,
  );
});
