import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import sanitizeHtml from "sanitize-html"

type Bindings = {
  [key in keyof CloudflareBindings]: CloudflareBindings[key]
}

const app = new Hono<{ Bindings: Bindings }>()

const isValidURL = (value: string) => {
  try {
    new URL(value)
    return true
  } catch (error) {
    return false
  }
}

app.get(
  "/",
  zValidator("query", z.object({ hnURL: z.string().refine(isValidURL) })),
  async (c) => {
    const { hnURL } = c.req.valid("query")

    const url = new URL(hnURL).toString()

    const res = await fetch(url)

    const rawHTML = await res.text()

    const comments = rawHTML.match(/<div class="commtext c00">(.*?)<\/div>/g)

    if (!comments) {
      return c.text("No comments found")
    }

    const sanitizedComments = comments.map((comment) =>
      sanitizeHtml(comment, {
        allowedTags: [],
        allowedAttributes: {},
      })
    )

    return c.json({ comments: sanitizedComments })
  }
)

export default app
