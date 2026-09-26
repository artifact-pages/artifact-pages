# HTML heading navigation creates inconsistent back history

- Status: Open
- Priority: P1
- Area: HTML artifact viewer and browser history

## Problem

Following an indexed heading in an HTML artifact creates a back-navigation state where the logical URL and the iframe content disagree. A reader needs two Back actions to undo one heading jump.

## Evidence and reproduction

1. Open `/showcase/editorial/field-notes/index.html` and use Contents or `#` search to choose “Practice over prediction.”
2. The logical URL becomes `/showcase/editorial/field-notes/index.html#practice`, and the iframe moves to the section.
3. Press Back once. The iframe returns to its unfragmented document and scrolls to the start, while the logical URL still ends in `#practice`.
4. Press Back again. Only then does the logical URL lose the fragment.

## Expected outcome

One Back action reverses one heading jump, with the address bar and visible section describing the same state.

## Acceptance criteria

- [ ] Heading navigation updates the logical URL and visible iframe section together.
- [ ] One Back and one Forward action each restore a matching URL and section.
- [ ] Reloading a logical URL with a heading fragment restores that section.
