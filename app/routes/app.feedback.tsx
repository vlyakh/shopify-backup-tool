import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Free text from merchants. Capped so a paste of an entire log file can't
// bloat a row; the cap is generous enough that nobody writing in good faith
// will hit it.
const MAX_MESSAGE = 4000;
const MAX_EMAIL = 200;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const message = String(form.get("message") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const kindRaw = String(form.get("kind") ?? "OTHER");
  const kind =
    kindRaw === "PROBLEM" || kindRaw === "REQUEST" ? kindRaw : "OTHER";

  if (!message) {
    return json({ ok: false, error: "Please write a message first." as string | null });
  }

  await prisma.feedback.create({
    data: {
      storeId: session.shop,
      kind,
      message: message.slice(0, MAX_MESSAGE),
      // Store null rather than "" so "did they want a reply?" is a real
      // question the data can answer.
      email: email ? email.slice(0, MAX_EMAIL) : null,
    },
  });

  return json({ ok: true, error: null as string | null });
};

export default function Feedback() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const sending = navigation.state === "submitting";

  const [kind, setKind] = useState("PROBLEM");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");

  const sent = actionData?.ok === true;

  const send = () => {
    submit({ kind, message, email }, { method: "POST" });
    setMessage("");
    setEmail("");
  };

  return (
    <Page title="Send feedback">
      <TitleBar title="Send feedback" />
      <BlockStack gap="500">
        {sent && (
          <Banner title="Thanks — that went through" tone="success">
            <p>
              Your message has been sent to the developer. If you left an email
              address you may get a reply.
            </p>
          </Banner>
        )}
        {actionData?.ok === false && actionData.error && (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              Found something wrong, or want the app to do something it does not
              do yet? Tell us here. It goes straight to the developer.
            </Text>

            <Select
              label="What is this about?"
              options={[
                { label: "Something is not working", value: "PROBLEM" },
                { label: "I would like a new feature", value: "REQUEST" },
                { label: "Something else", value: "OTHER" },
              ]}
              value={kind}
              onChange={setKind}
            />

            <TextField
              label="Your message"
              value={message}
              onChange={setMessage}
              multiline={6}
              autoComplete="off"
              maxLength={MAX_MESSAGE}
              helpText="If something went wrong, telling us what you were doing at the time helps a lot."
            />

            <TextField
              label="Email for a reply (optional)"
              value={email}
              onChange={setEmail}
              type="email"
              autoComplete="email"
              maxLength={MAX_EMAIL}
              helpText="Leave blank if you do not want a reply."
            />

            <InlineStack>
              <Button
                variant="primary"
                onClick={send}
                loading={sending}
                disabled={!message.trim()}
              >
                Send feedback
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
