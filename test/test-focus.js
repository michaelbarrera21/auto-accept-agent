const vscode = require('vscode');

exports.activate = function (context) {
    console.log('Focus Test Activated');

    // Log initial state
    console.log('Initial Focus State:', vscode.window.state.focused);

    // Listen for changes
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(state => {
            console.log('Window State Changed. Focused:', state.focused);
            vscode.window.showInformationMessage(`Focus: ${state.focused}`);
        })
    );
};
