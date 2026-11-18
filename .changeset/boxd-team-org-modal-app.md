---
"@beachside/boxd": minor
"@beachside/modal": minor
---

boxd accepts a member key fenced to any org it belongs to, not only the user's default org; machines, disks and snapshots still go to the configured `org`. Modal looks up the App once at connect and no longer repeats the lookup before every list, reopen, create and delete.
