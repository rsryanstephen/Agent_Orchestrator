The local prompt history file for this topic is getting too long. I think once the prompt history file gets longer than 4000 lines, the harness needs to automatically create a back up of the existing prompt history file and then compress the other prompt file that will be used for further prompts before another prompt gets submitted.

Clear feedback must be provided in both the CLI and the prompt file itself so the user can see what is happening or what happened before, leaving a clear audit trail.

---

I recently added `hprobe()` To shell-functions.txt myself, as I noticed that one could Run `node Claude_Code_Harness/src/run-agent.js --probe` but there was no alias function assigned.

I need you to run through the code carefully and check what other functions in this harness can we call for which we have no shell functions defined, and add the alias functions if they are missing. Each shell function must have a comment above it explaining what it does.

Finally, please update the README to reference all new shell functions.

The
