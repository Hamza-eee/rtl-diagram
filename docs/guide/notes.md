# Notes

[← Back to the README](../../README.md)

Right-click a port, pin, wire, block or empty space and choose **Add note**. Pick **Note**, **Question** or **Issue**, write it, and optionally tick **Only this instance**.

- A note on a module's port shows wherever that module is used, unless it is pinned to one instance.
- Click a speech bubble to open the **Notes** tab. There, notes can be edited, resolved, reopened, deleted or jumped to.
- If the port or instance a note points at disappears from the RTL, the note is listed as **Detached**, with the reason. It is never dropped.

## Sharing notes

Each note is a small JSON file in `.rtl-notes/` inside the project folder. Commit that folder, and the rest of the team sees the notes after a pull. With one file per note, two people adding notes never get a merge conflict.

The author is taken from your git `user.name`. Note files are validated when read, and the extension writes only inside the notes folder.
