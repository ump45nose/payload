import { screenReaderTest as test } from '@guidepup/playwright'
import { expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatAdminURL } from 'payload/shared'

import { openGroupBy } from '../__helpers/e2e/groupBy/index.js'
import { AdminUrlUtil } from '../__helpers/shared/adminUrlUtil.js'
import { initPayloadE2ENoConfig } from '../__helpers/shared/initPayloadE2ENoConfig.js'
import { initPage } from '../__setup/e2e/initPage.js'
import { devUser } from '../credentials.js'
import {
  addCollectionQueryWidget,
  captureScreenReader,
  captureScreenReaderOutput,
  gotoFirstPost,
  gotoPostsList,
  navigateScreenReaderTo,
  openBulkEditFieldSelect,
  openCopyToLocaleDrawer,
  openDashboardEditor,
  openDragReorderField,
  openFirstBlockActions,
  openNavigationFolders,
  openPostsFilter,
  openVersionComparison,
  openWidgetDrawer,
  waitForKeyboardDragActivation,
} from './helpers.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

test.describe('WCAG 2.2 Level AA — Screen readers', () => {
  let postsURL: AdminUrlUtil
  let serverURL: string

  test.use({ screenReaderStartOptions: { capture: true } })

  test.beforeAll(async ({ browser: _browser }) => {
    ;({ serverURL } = await initPayloadE2ENoConfig({ dirname }))
    postsURL = new AdminUrlUtil(serverURL, 'posts')
  })

  test.beforeEach(async ({ page, screenReader }) => {
    const loginResponse = await page.request.post(
      formatAdminURL({ apiRoute: '/api', path: '/users/login', serverURL }),
      { data: devUser },
    )

    expect(loginResponse.ok()).toBe(true)
    await initPage({ page, serverURL })
    page.removeAllListeners('console')
    await screenReader.navigateToWebContent()
  })

  test.describe('1.3.1 Info and Relationships (A)', () => {
    for (const kind of ['Array', 'Blocks'] as const) {
      test(`should announce relative direction and position while dragging the ${kind} row`, async ({
        page,
        screenReader,
      }) => {
        // PYLD-3626
        const { handle } = await openDragReorderField({ kind, page, postsURL })

        await handle.focus()
        await screenReader.press('Space')
        await expect(handle).toHaveAttribute('aria-pressed', 'true')
        await waitForKeyboardDragActivation({ page })
        try {
          const output = await captureScreenReaderOutput({
            action: () =>
              page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'ArrowDown'),
            screenReader,
          })

          expect.soft(output).toMatch(/down|after|below/i)
          expect(output).toMatch(/(?:position|order)(?:\s*:\s*|\s+)2|2 (?:of|out of) 2|second/i)
        } finally {
          await screenReader.press('Escape')
        }
      })
    }

    test(
      'should announce table cell text once without conflicting sort commands',
      { tag: ['@collection-navigation', '@admin-navigation'] },
      async ({ page, screenReader }) => {
        // PYLD-3750
        // PYLD-3596
        await gotoPostsList({ page, postsURL })
        const title = 'Example post two'
        const grid = page.getByRole('grid', { name: 'Posts', exact: true })
        const rows = grid.locator('tbody tr')
        const row = rows.filter({
          has: page.getByRole('link', { name: title, exact: true }),
        })
        const titleCell = row.locator('.cell-title')

        await expect(row).toHaveCount(1)
        const rowIndex = await row.evaluate((element) =>
          Array.from(element.parentElement!.children).indexOf(element),
        )

        await page.getByRole('link', { name: 'Create New', exact: true }).focus()
        for (let index = 0; index < 8; index++) {
          await page.keyboard.press('Tab')
          if (await grid.evaluate((element) => element.contains(document.activeElement))) {
            break
          }
        }
        await expect(rows.first().locator('.cell--linked')).toBeFocused()
        await page.keyboard.press('Home')
        for (let index = 0; index < rowIndex; index++) {
          await page.keyboard.press('ArrowDown')
        }
        await expect(row.getByRole('checkbox')).toBeFocused()
        const capture = await captureScreenReader({
          action: () => page.keyboard.press('ArrowRight'),
          screenReader,
        })
        const spoken = capture.spokenPhrase

        await expect(titleCell).toBeFocused()
        expect(capture.itemText).toContain(title)
        expect(spoken).toMatch(/link/i)
        expect(spoken.match(/Example post two/gi) || []).toHaveLength(1)
        expect(spoken).not.toMatch(/ascending.*descending|descending.*ascending/i)
        expect(spoken).not.toMatch(/sort by|\{\{label\}\}/i)
      },
    )

    test('should communicate removed version text while browsing the comparison', async ({
      page,
      screenReader,
    }) => {
      // PYLD-3722
      await openVersionComparison({
        page,
        postsURL,
        serverURL,
        versionIndex: 0,
      })
      const removed = page.locator('.text-diff [data-match-type="delete"]').first()

      await expect(removed).toBeVisible()
      await expect(removed).toHaveCSS('text-decoration-line', 'line-through')
      const removedText = (await removed.innerText()).trim()

      expect(removedText).not.toBe('')
      const oldGroup = await navigateScreenReaderTo({
        matches: /Comparing against.*group|group.*Comparing against/i,
        screenReader,
        shouldSkipToContent: screenReader.name === 'VoiceOver',
      })

      expect(oldGroup).toMatch(/Comparing against/i)
      await screenReader.clearSpokenPhraseLog()
      let hasReachedRemovedText = false

      for (let index = 0; index < 30; index++) {
        await screenReader.next()
        const item = await screenReader.itemText()

        if (item.includes(removedText)) {
          hasReachedRemovedText = true
          break
        }
      }

      expect(hasReachedRemovedText, `Did not reach removed text: ${removedText}`).toBe(true)
      const spoken = (await screenReader.spokenPhraseLog()).join(' ')

      expect(spoken).toContain(removedText)
      expect(spoken).toMatch(/deleted|deletion|removed|strikethrough|strike through/i)
      const newGroup = await navigateScreenReaderTo({
        matches: /^(?!.*Previous Version)(?:Version.*group|group.*Version)/i,
        screenReader,
        shouldSkipToContent: screenReader.name === 'VoiceOver',
      })

      expect(newGroup).not.toMatch(/Comparing against/i)
    })

    test(
      'should announce the deletion dialog before background page content',
      { tag: ['@dialogs', '@trash'] },
      async ({ page, screenReader }) => {
        // PYLD-3769
        await gotoFirstPost({ page, postsURL, serverURL })
        await page.locator('.doc-controls__popup .popup__trigger-wrap button').click()
        const trigger = page.getByRole('menuitem', {
          name: 'Delete',
          exact: true,
        })

        await trigger.focus()
        const capture = await captureScreenReader({
          action: () => trigger.press('Enter'),
          screenReader,
        })

        await expect(
          page.locator('[id^="delete-"]').filter({ has: page.locator('.dialog') }),
        ).toBeVisible()
        expect(capture.spokenPhrase).toMatch(
          /(delete|trash|confirm).*dialog|dialog.*(delete|trash|confirm)/i,
        )
        expect(capture.spokenPhrase).not.toMatch(
          /skip to content|navigation landmark|dashboard|subtitle/i,
        )
      },
    )
  })
  test.describe('2.1.1 Keyboard (A)', () => {
    for (const kind of ['Array', 'Blocks'] as const) {
      test(`should drop the ${kind} row with the screen reader active`, async ({
        page,
        screenReader,
      }) => {
        // PYLD-3625
        const { handle, rows, values } = await openDragReorderField({
          kind,
          page,
          postsURL,
        })

        const initialSecondTop = (await rows.nth(1).boundingBox())!.y

        await handle.focus()
        try {
          await screenReader.press('Space')
          await expect(handle).toHaveAttribute('aria-pressed', 'true')
          await waitForKeyboardDragActivation({ page })
          await screenReader.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'ArrowDown')
          await expect
            .poll(async () => (await rows.nth(1).boundingBox())!.y)
            .toBeLessThan(initialSecondTop)
          await screenReader.press('Space')
          await expect(values.nth(0)).toHaveValue('Second drag row')
          await expect(values.nth(1)).toHaveValue('First drag row')
          await expect(rows.nth(1).getByRole('button', { name: /drag to reorder/i })).toBeFocused()
          await expect(page.locator('body')).not.toHaveClass(/is-dragging/)
        } finally {
          await screenReader.press('Escape')
        }
      })
    }
  })

  test.describe('2.4.3 Focus Order (A)', () => {
    test.describe('Safari and VoiceOver report', () => {
      test.skip(process.platform !== 'darwin', 'Safari and VoiceOver report')

      test('should reach widget edit size and remove controls with the VoiceOver cursor', async ({
        page,
        screenReader,
      }) => {
        // PYLD-3573
        await openDashboardEditor({ page, serverURL })
        const widget = await addCollectionQueryWidget({ page })
        await widget.locator('.draggable').focus()
        await navigateScreenReaderTo({
          matches: /edit.*collection query/i,
          maxSteps: 8,
          screenReader,
          shouldMoveCursorToKeyboardFocus: true,
          shouldResetCursor: false,
          startAt: widget.locator('.draggable'),
        })
        expect(await screenReader.itemText()).toMatch(/edit.*collection query/i)
        await screenReader.act()
        await expect(page.locator('[id^="widget-editor-"]:visible')).toHaveCount(1)
        await page.keyboard.press('Escape')
        const sizeText = (await widget.locator('.widget-wrapper__size-btn').innerText()).trim()
        await navigateScreenReaderTo({
          matches: /edit.*collection query/i,
          maxSteps: 8,
          screenReader,
          shouldMoveCursorToKeyboardFocus: true,
          shouldResetCursor: false,
          startAt: widget.locator('.draggable'),
        })
        let hasReachedSize = false
        for (let index = 0; index < 8; index++) {
          await screenReader.next()
          const output = await screenReader.itemText()
          if (
            output.toLowerCase().includes(sizeText.toLowerCase()) &&
            /resize.*collection query/i.test(output) &&
            /button/i.test(output)
          ) {
            hasReachedSize = true
            break
          }
          if (/delete.*collection query/i.test(output)) {
            break
          }
        }
        expect(hasReachedSize).toBe(true)
        await screenReader.act()
        await expect(widget.locator('.widget-wrapper__size-btn')).toHaveAttribute(
          'aria-expanded',
          'true',
        )
        await page.keyboard.press('Escape')
        await navigateScreenReaderTo({
          matches: /delete.*collection query/i,
          maxSteps: 8,
          screenReader,
          shouldMoveCursorToKeyboardFocus: true,
          shouldResetCursor: false,
          startAt: widget.locator('.draggable'),
        })
        expect(await screenReader.itemText()).toMatch(/delete.*collection query/i)
        await screenReader.act()
        await expect(widget).toHaveCount(0)
      })
    })

    test('should move the screen-reader cursor into the add-widget drawer upon opening', async ({
      page,
      screenReader,
    }) => {
      // PYLD-3644
      const { drawer, trigger } = await openWidgetDrawer({ page, serverURL })

      await trigger.focus()
      const capture = await captureScreenReader({
        action: () => trigger.press('Enter'),
        screenReader,
      })

      await expect(drawer).toBeVisible()
      expect(capture.itemText).toMatch(/close|add widget|search widgets/i)
      expect(capture.spokenPhrase).not.toMatch(/editing dashboard|save changes/i)
    })

    test(
      'should move the screen-reader cursor into Copy to locale from the overflow menu',
      { tag: ['@document-editing'] },
      async ({ page, screenReader }) => {
        // PYLD-3682
        await gotoFirstPost({ page, postsURL, serverURL })
        await page.locator('.doc-controls__popup .popup__trigger-wrap button').click()
        const trigger = page.locator('#copy-locale-data__button')

        await trigger.focus()
        const capture = await captureScreenReader({
          action: () => trigger.press('Enter'),
          screenReader,
        })

        const drawer = page.locator('#copy-locale')

        await expect(drawer).toBeVisible()
        await expect(
          drawer.getByRole('heading', { name: 'Copy to locale', exact: true }),
        ).toBeVisible()
        expect(capture.itemText).toMatch(
          /close|copy to locale.*(?:dialog|heading)|dialog.*copy to locale|copy to.*(combo|pop)/i,
        )
        expect(capture.itemText).not.toMatch(/skip to content|dashboard|more options/i)
      },
    )

    test(
      'should expose one screen-reader stop for the Copy to locale select',
      { tag: ['@document-editing'] },
      async ({ page, screenReader }) => {
        // PYLD-3680
        const drawer = await openCopyToLocaleDrawer({
          page,
          postsURL,
          serverURL,
        })
        const combobox = drawer.locator('#field-toLocale input[role="combobox"]')

        const firstStop = await captureScreenReader({
          action: () => combobox.focus(),
          screenReader,
        })
        const selectStops = [firstStop.itemText]
        let hasReachedNextField = false

        for (let index = 0; index < 8; index++) {
          await screenReader.next()
          const itemText = await screenReader.itemText()

          if (/overwrite existing field data/i.test(itemText)) {
            hasReachedNextField = true
            break
          }
          selectStops.push(itemText)
        }

        expect(hasReachedNextField, `Screen-reader stops: ${JSON.stringify(selectStops)}`).toBe(
          true,
        )
        expect(selectStops, `Screen-reader stops: ${JSON.stringify(selectStops)}`).toHaveLength(1)
      },
    )

    test(
      'should expose disabled row-menu actions to screen-reader navigation',
      { tag: ['@admin-navigation'] },
      async ({ page, screenReader }) => {
        // PYLD-3745
        const menu = await openFirstBlockActions({ page, postsURL })
        const output = await navigateScreenReaderTo({
          matches: /paste|replace/i,
          maxSteps: 12,
          screenReader,
          shouldResetCursor: screenReader.name !== 'VoiceOver',
          startAt: menu.getByRole('menuitem', { name: 'Duplicate', exact: true }),
        })

        expect(output).toMatch(/dimmed|disabled|unavailable/i)
      },
    )

    test(
      'should keep the disabled Group by sort control in screen-reader navigation',
      { tag: ['@admin-navigation'] },
      async ({ page, screenReader }) => {
        // PYLD-3784
        await gotoPostsList({ page, postsURL })
        const { groupByContent } = await openGroupBy(page)

        await expect(
          groupByContent.getByRole('button', { name: 'Sort', exact: true }),
        ).toHaveAttribute('aria-disabled', 'true')
        const output = await navigateScreenReaderTo({
          matches: /sort.*(?:button|pop.?up)|(?:button|pop.?up).*sort/i,
          maxSteps: 12,
          screenReader,
          shouldEnterDialogs: true,
          startAt: groupByContent.getByRole('button', { name: 'Close', exact: true }),
        })

        expect(output).toMatch(/dimmed|disabled|unavailable/i)
      },
    )
  })

  test.describe('4.1.2 Name, Role, Value (A)', () => {
    test(
      'should announce filter and bulk-edit options by name',
      { tag: ['@admin-navigation'] },
      async ({ page, screenReader }) => {
        // PYLD-3752
        const whereBuilder = await openPostsFilter({ page, postsURL })
        const filterComboboxes = whereBuilder.locator('input[role="combobox"]')

        expect(await filterComboboxes.count()).toBeGreaterThan(0)
        for (let index = 0; index < (await filterComboboxes.count()); index++) {
          await filterComboboxes.nth(index).focus()
          await filterComboboxes.nth(index).press('ArrowDown')
          await filterComboboxes.nth(index).press('ArrowDown')
          const optionName = (await page.locator('.rs__option--is-focused').innerText()).trim()
          await page.keyboard.press('Escape')
          await filterComboboxes.nth(index).focus()
          const output = await captureScreenReaderOutput({
            action: async () => {
              await filterComboboxes.nth(index).press('ArrowDown')
              await filterComboboxes.nth(index).press('ArrowDown')
            },
            screenReader,
          })

          expect(output.toLocaleLowerCase()).toContain(optionName.toLocaleLowerCase())
          expect(output).not.toMatch(/\bblank\b/i)
          expect(output).not.toContain('[object Object]')
          await page.keyboard.press('Escape')
        }

        const fieldSelect = await openBulkEditFieldSelect({ page, postsURL })
        const bulkEditCombobox = fieldSelect.locator('input[role="combobox"]')
        await bulkEditCombobox.focus()
        await bulkEditCombobox.press('ArrowDown')
        await bulkEditCombobox.press('ArrowDown')
        const optionName = (await page.locator('.rs__option--is-focused').innerText()).trim()
        await page.keyboard.press('Escape')
        await bulkEditCombobox.focus()
        const output = await captureScreenReaderOutput({
          action: async () => {
            await bulkEditCombobox.press('ArrowDown')
            await bulkEditCombobox.press('ArrowDown')
          },
          screenReader,
        })

        expect(output.toLocaleLowerCase()).toContain(optionName.toLocaleLowerCase())
        expect(output).not.toMatch(/\bblank\b/i)
        expect(output).not.toContain('[object Object]')
      },
    )
  })
  test.describe('4.1.3 Status Messages (AA)', () => {
    test(
      'should announce the unsaved Copy to locale toast without its close button',
      { tag: ['@document-editing'] },
      async ({ page, screenReader }) => {
        // PYLD-3669
        await gotoFirstPost({ page, postsURL, serverURL })
        await screenReader.navigateToWebContent()
        await page.locator('#field-title').fill('Unsaved toast announcement regression')
        await page.locator('.doc-controls__popup .popup__trigger-wrap button').click()
        const capture = await captureScreenReader({
          action: async () => {
            await page.locator('#copy-locale-data__button').click()
            await expect(
              page.locator('[data-sonner-toast]').filter({ hasText: /unsaved/i }),
            ).toBeVisible()
          },
          screenReader,
        })

        expect(capture.spokenPhrase).toMatch(/unsaved/i)
        expect(capture.spokenPhrase).not.toMatch(/close toast/i)
      },
    )

    test('should announce global API depth changes while focus stays on the stepper', async ({
      page,
      screenReader,
    }) => {
      // PYLD-3618
      await page.goto(
        formatAdminURL({
          adminRoute: '/admin',
          path: '/globals/menu/api',
          serverURL,
        }),
      )
      const depth = page.getByRole('spinbutton', {
        name: 'Depth',
        exact: true,
      })
      await expect(depth).toBeVisible()
      await screenReader.navigateToWebContent()
      const initialDepth = Number(await depth.inputValue())
      const field = page.locator('.field-type.number').filter({ has: depth })

      for (const { name, value } of [
        { name: 'Increment', value: initialDepth + 1 },
        { name: 'Decrement', value: initialDepth },
      ]) {
        const stepper = field.getByRole('button', { name, exact: true })
        await stepper.focus()
        const capture = await captureScreenReader({
          action: async () => {
            await stepper.press('Enter')
            await expect(depth).toHaveValue(String(value))
          },
          screenReader,
        })
        await expect(stepper).toBeFocused()
        expect.soft(capture.spokenPhrase).toMatch(new RegExp(`\\b${value}\\b`))
      }
    })

    test(
      'should announce table search result changes without moving focus',
      { tag: ['@collection-navigation', '@admin-navigation'] },
      async ({ page, screenReader }) => {
        // PYLD-3696, PYLD-3773: result-announcement coverage complements the browser search-hint checks.
        test.setTimeout(60000)
        await gotoPostsList({ page, postsURL })
        const search = page.getByRole('textbox', { name: /search/i }).first()

        await search.focus()
        for (const { count, query, speech } of [
          {
            count: 1,
            query: 'Example post two',
            speech: /results found for.*(?:1|one)/i,
          },
          {
            count: 0,
            query: 'no-such-accessibility-post',
            speech: /results found for.*(?:0|zero)/i,
          },
        ]) {
          const capture = await captureScreenReader({
            action: async () => {
              await search.fill(query)
              await expect(page.locator('tbody tr')).toHaveCount(count)
              await expect(page.getByRole('status').filter({ hasText: query })).toContainText(
                String(count),
              )
            },
            screenReader,
          })

          await expect(search).toBeFocused()
          expect(capture.spokenPhrase).toMatch(speech)
        }
      },
    )

    test(
      'should announce navigation folder search results without moving focus',
      { tag: ['@admin-navigation'] },
      async ({ page, screenReader }) => {
        // PYLD-3582
        const sidebar = await openNavigationFolders({ page, serverURL })
        const search = sidebar.getByRole('textbox')
        const originalURL = page.url()

        await search.fill('Accessibility child folder')
        const capture = await captureScreenReader({
          action: async () => {
            await search.press('Enter')
            await expect(sidebar.locator('.hierarchy-search-results__list')).toContainText(
              'Accessibility child folder',
            )
          },
          screenReader,
        })

        await expect(search).toBeFocused()
        await expect(page).toHaveURL(originalURL)
        expect(capture.spokenPhrase).toMatch(
          /(?:1|one)\s+(?:search\s+)?result|(?:1|one)\s+folder|found\s+(?:1|one)|showing\s+(?:1|one)\s+of\s+(?:1|one)/i,
        )
      },
    )
  })
})
