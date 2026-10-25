# RunMeterの共有用画像

OGPとXカードには、同じ1200×630のPNGを使用します。正式ロゴのゲージと、日本語の「使用率と次のリセットを、ひと目で。」を中心にした構成です。使用率や日時などの架空データは載せません。

- 出力：`src/app/opengraph-image.png`、`src/app/twitter-image.png`
- 代替テキスト：同じフォルダーの各`.alt.txt`
- ロゴの参照元：`public/brand/runmeter-logo-dark.svg`、`public/brand/runmeter-appicon.svg`
- 制作方法：組込み`imagegen`の編集モードで構成を作成し、正式なワードマークとアプリアイコンを参照元のSVGから再合成。PNGの書き出し時に1200×630へ整形・圧縮し、画像のメタデータは保持しません。
- ブランド素材の権利：[ロゴ・ブランド素材の表記](../BRANDING_LICENSE.md)

Next.jsの画像ファイル規約でメタタグと画像URLを生成します。画像更新時は本番ビルドで`og:image`と`twitter:image`、寸法、代替テキストを確認します。

## 制作プロンプト

最初の参照画像は旧OGP（ソースの`d769962`時点）、2枚目は正式ワードマーク、3枚目は正式アプリアイコンです。

```text
Use case: ads-marketing / precise brand compositing. Asset: production OGP social sharing banner for RunMeter. Rebuild Image 1 completely as a quiet, professional, very simple Japanese graphic, landscape 1200:630 aspect ratio (about 1.905:1). Image 1 is the obsolete edit target; remove its heartbeat icon, neon cyan, glow, grid, invented line chart, legend, realtime badge and pills. Image 2 is the actual supplied RunMeter logo that MUST appear faithfully as the upper-left wordmark: preserve the exact open gauge arc, diagonal needle, RunMeter spelling, shape and colors. Image 3 is the actual supplied application icon and MUST appear faithfully, once, as a flat supporting image on the right. Do not invent, redesign, replace, embellish or distort either reference logo. Overall palette: completely flat charcoal #101215 background, brand muted teal #82AAA2, main text #ECEEEF, secondary #9BA1A9, subtle separator #2B3036. No gradients, glows, shadows, grids, chart/data visuals, made-up percentages, reset dates, decorative AI shapes, mock UI, screenshots or extra symbols. Layout for a 1200 by 630 crop: ample 72px-safe margins; upper-left Image 2 logo at about 340px wide, left-aligned strong Japanese typography in the middle, Image 3 about 240px square at right center with plenty of space around it, one fine horizontal separator and developer credit at the bottom. Main exact headline in two lines: line 1 "使用率と次のリセットを、" and line 2 "ひと目で。". Main headline must be the dominant, very legible feature, using a clean Japanese sans-serif with sensible spacing; line 2 can be larger or muted teal. Supporting exact line: "Codex・Claude の利用枠をまとめて確認". Privacy text below, smaller but legible, exact two lines: "認証情報・利用履歴は、この端末で管理" and "運営サーバーへの送信・保存なし". Bottom credit exact: "開発：サイバーアイ・テクノロジー株式会社"; small bottom-right domain exact: "cybereye-tech.jp". All important text and logos remain well inside the safe margins and readable at small thumbnail size. All text must be accurately written in Japanese exactly as specified, with no additional words. This should look like a restrained editorial brand cover with careful typography, not an AI technology poster. Output one finished banner with crisp, flat edges and no external frame.
```

## 仕上げのプロンプト

最初の出力を1枚目、正式ワードマークとアプリアイコンを2・3枚目として参照します。

```text
Edit Image 1 with one focused change: remove ALL 3D/gloss/metallic/bevel/grain/lighting/texture/shadow/gradient rendering and make this a perfectly flat, crisp 2D graphic like a clean SVG export. KEEP the existing layout, spacing, word positions, font sizes, overall dimensions/aspect ratio and EVERY WORD of Japanese text and the cybereye-tech.jp domain exactly unchanged. KEEP the provided RunMeter identity: upper-left logo must faithfully use Image 2's open gauge arc, diagonal needle, exact RunMeter wordmark geometry and solid colors; right application icon must faithfully use Image 3's flat solid #15181C background, exact teal gauge shape and solid muted teal #82AAA2. No shine on the gauge, logo, text or icon panel. Background must be a uniform flat #101215 with zero texture or gradient. Headline line 1 solid #ECEEEF, headline line 2 solid #82AAA2. Supporting text flat #9BA1A9, footer line flat #2B3036. Anti-aliasing at edges is fine, every filled surface otherwise has a single solid color. Do not add or delete any object or text. Exact existing headline: 使用率と次のリセットを、 / ひと目で。 Exact secondary: Codex・Claude の利用枠をまとめて確認. Exact privacy: 認証情報・利用履歴は、この端末で管理 / 運営サーバーへの送信・保存なし. Exact footer: 開発：サイバーアイ・テクノロジー株式会社 and cybereye-tech.jp. The result must feel quiet and professionally typeset, with no artificial material or atmospheric effect.
```
