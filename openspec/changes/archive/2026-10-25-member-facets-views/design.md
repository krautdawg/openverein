## Decisions

- **Views are URL parameters.** A view is exactly what a shareable link already encodes; opening it replaces the URL. Nothing about permissions is stored with it, so a shared view can never show more than the viewer may see.
- **Sharing is an admin act.** Only settings-write users can share with a role, so a trainer cannot push views to other roles.
