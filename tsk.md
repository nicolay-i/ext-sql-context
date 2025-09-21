1. Need to add an extension settings page to move the functionality for adding/changing/removing database connection settings, as well as export and import methods from .env format.
This should be a separate file for webview.

1.2. HTML needs to be saved in a separate file and connected in settingsWebView

1.3. Need to style for VS Code.
Add tabs: connection settings and file generation settings
Show a message when copying to clipboard

1.4. The "Import from .env" section needs to be collapsible by clicking on the header to save space. Initially collapsed.

1.5. Need to add a "test connection" button in the connection data form.

1.6. Need to explicitly show that connection data has not been saved yet if the user changed it but did not click "Save".

1.7. Need to add an icon for the extension

1.8. Need to add a "Start Generation" button in the file generation settings form, which will run the file generation command. No need to show path prompt - use the template.

1.9. Need to make the "File Generation Settings" tab first in the list of tabs, and open it by default if no connection settings are saved.



