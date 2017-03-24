'use strict';

import * as path from "path"
import * as vscode from 'vscode';
import * as latex_workshop from './extension';
import * as latex_data from './data';
import {getPreviewPosition} from './preview';
import {find_main_document} from './utilities';

var requirejs = require('requirejs');
requirejs.config({
    nodeRequire: require
});

var compiling = false,
    to_compile = false,
    prev_time = 0;

export async function compile(here = false) {
    vscode.workspace.saveAll();
    find_main_document(here);
    getPreviewPosition();

    if (latex_data.main_document == undefined) return;

    // Develop file name related variables
    let uri = vscode.Uri.file(latex_data.main_document);

    // Wait if currently compiling
    if (compiling) {
        if (Date.now() - prev_time > 500) {
            to_compile = true;
            prev_time = Date.now();
        }
        return;
    } else {
        compiling = true;
        to_compile = false;
    }

    // Initialize
    latex_workshop.latex_output.clear();
    latex_workshop.workshop_output.clear();

    // Sequentially execute all commands
    var configuration = vscode.workspace.getConfiguration('latex-workshop');
    let cmds = configuration.get('compile_workflow') as Array<string>;
    let error_occurred = false;
    var log_content;
    for (let cmd_idx = 0; cmd_idx < cmds.length; ++cmd_idx){
        // Parse placeholder
        let cmd = cmds[cmd_idx];
        cmd = replace_all(cmd, '%compiler%', configuration.get('compiler'));
        cmd = replace_all(cmd, '%arguments%', configuration.get('compile_argument'));
        cmd = replace_all(cmd, '%document%', '"' + path.basename(latex_data.main_document, '.tex') + '"');
        vscode.window.setStatusBarMessage(`Step ${cmd_idx + 1}`, 3000);
        latex_workshop.workshop_output.append(`Step ${cmd_idx + 1}: ${cmd}\n`);

        // Execute command
        let promise = require('child-process-promise').exec(cmd, {cwd:path.dirname(latex_data.main_document)});
        let child = promise.childProcess;
        log_content = '';
        child.stdout.on('data', (data) => {
            latex_workshop.latex_output.append(data);
            log_content += data;
        });
        // Wait command finish
        await promise.catch((err) => {
            vscode.window.setStatusBarMessage(`Step ${cmd_idx + 1} failed (exit code: ${err.code}).`, 6000);
            error_occurred = true;
        });

        // Terminate if error
        if (error_occurred) {
            to_compile = false;
            break;
        }
    }

    var LatexLogParser = require(latex_workshop.find_path('lib/latex-log-parser'));
    var entries = LatexLogParser.parse(log_content);
    const diagnositic_severity = {
                'typesetting': vscode.DiagnosticSeverity.Hint,
                'warning': vscode.DiagnosticSeverity.Warning,
                'error': vscode.DiagnosticSeverity.Error,
    };
    const diagnostics = vscode.languages.createDiagnosticCollection('latex');
    var log_level = configuration.get('log_level');
    if (entries.all.length > 0) {
        const diags_per_file: {[key:string]:vscode.Diagnostic[]} = {}
        for (var entry of entries.all) {
            if ((entry.level == 'typesetting' && log_level == 'all') ||
                (entry.level == 'warning' && log_level != 'error') ||
                (entry.level == 'error')) {
                const range = new vscode.Range(new vscode.Position(entry.line - 1, 0), 
                                               new vscode.Position(entry.line - 1, 0));
                const diag = new vscode.Diagnostic(range, entry.message, diagnositic_severity[entry.level]);
                if (diags_per_file[entry.file] === undefined) {
                    diags_per_file[entry.file] = [];
                }
                diags_per_file[entry.file].push(diag);
            }
         }

        // clear any previous run LaTeX diagnostics...
        diagnostics.clear();
        // ...and map over all diagnostics per file and set them.
        Object.keys(diags_per_file).forEach(path => {
            const diags = diags_per_file[path];
            const uri = vscode.Uri.file(vscode.workspace.rootPath + '/' + vscode.workspace.asRelativePath(path));
            diagnostics.set(uri, diags);
        })

    }

    // Succeed in all steps
    if (!error_occurred) {
        vscode.window.setStatusBarMessage('LaTeX compiled.', 3000);
        latex_workshop.preview_provider.update(uri);
    }
    compiling = false;
    if (to_compile) compile();
}

function replace_all(str, from, to) {
    return str.split(from).join(to);
}
