// Block Kit modal for /kurate. Category options carry the emoji in the label,
// so the submitted value already contains the leading emoji we'll use in the
// posted message — no branching needed.

const CATEGORY_OPTIONS = [
  "📚 Books",
  "🎮 Games",
  "🎬 Movies & TV",
  "🎵 Music & Pods",
  "🍳 Recipes",
] as const;

export const KURATE_CALLBACK_ID = "kurate_submit";

export const KURATE_MODAL = {
  type: "modal",
  callback_id: KURATE_CALLBACK_ID,
  title: { type: "plain_text", text: "Kurate something ✨" },
  submit: { type: "plain_text", text: "Share" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "input",
      block_id: "category",
      label: { type: "plain_text", text: "What kind?" },
      element: {
        type: "static_select",
        action_id: "category",
        placeholder: { type: "plain_text", text: "Pick one" },
        options: CATEGORY_OPTIONS.map((label) => ({
          text: { type: "plain_text", text: label },
          value: label,
        })),
      },
    },
    {
      type: "input",
      block_id: "thing",
      label: { type: "plain_text", text: "What's it called?" },
      element: {
        type: "plain_text_input",
        action_id: "thing",
        placeholder: {
          type: "plain_text",
          text: "the alchemist, me myself and i, interstellar etc.",
        },
        max_length: 200,
      },
    },
    {
      type: "input",
      block_id: "author",
      optional: true,
      label: { type: "plain_text", text: "Who made it?" },
      element: {
        type: "plain_text_input",
        action_id: "author",
        placeholder: {
          type: "plain_text",
          text: "paulo coelho, beyonce, christopher nolan etc.",
        },
        max_length: 100,
      },
    },
    {
      type: "input",
      block_id: "link",
      optional: true,
      label: { type: "plain_text", text: "Got a link?" },
      element: {
        type: "url_text_input",
        action_id: "link",
        placeholder: { type: "plain_text", text: "paste it if you've got it" },
      },
    },
    {
      type: "input",
      block_id: "why",
      optional: true,
      label: { type: "plain_text", text: "Why's it good?" },
      element: {
        type: "plain_text_input",
        action_id: "why",
        placeholder: { type: "plain_text", text: "one line, no pressure" },
        max_length: 300,
      },
    },
  ],
};
