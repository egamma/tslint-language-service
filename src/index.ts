import * as ts_module from "../node_modules/typescript/lib/tsserverlibrary";
import * as tslint from 'tslint';
import * as path from 'path';

interface Map<V> {
    [key: string]: V;
}

let codeFixActions: Map<Map<tslint.Fix>> = Object.create(null);

function computeKey(start: number, end: number): string {
    return `[${start},${end}]`;
}

let configFile: string = null;
let configuration: tslint.Configuration.IConfigurationFile = null;
let isTsLint4: boolean = true;

let configCache = {
    filePath: <string>null,
    configuration: <any>null,
    isDefaultConfig: false,
    configFilePath: <string>null
};

let linter: typeof tslint.Linter = null;
let linterConfiguration: typeof tslint.Configuration = null;

let value = tslint;
linter = value.Linter;
linterConfiguration = value.Configuration;

if (!isTsLint4) {
    //linter = value;
}
/*function isTsLintVersion4(linter) {
    let version = '1.0.0';
    try {
        version = linter.VERSION;
    } catch (e) {
    }
    return semver.satisfies(version, ">= 4.0.0 || >= 4.0.0-dev");
}*/

function init(modules: { typescript: typeof ts_module }) {
  const ts = modules.typescript;

  function create(info: ts.server.PluginCreateInfo) {

    info.project.projectService.logger.info("tslint-language-service loaded");

    // Set up decorator
    const proxy = Object.create(null) as ts.LanguageService;
    const oldLS = info.languageService;
    for (const k in oldLS) {
      (<any>proxy)[k] = function () {
        return oldLS[k].apply(oldLS, arguments);
      }
    }

    function makeDiagnostic(problem: tslint.RuleFailure, file: ts.SourceFile): ts.Diagnostic {
        let message = (problem.getRuleName() !== null)
            ? `${problem.getFailure()} (${problem.getRuleName()})`
            : `${problem.getFailure()}`;

        // tslint5 supports to assign severities to rules
        let category;
        if ((<any>problem).getRuleSeverity && (<any>problem).getRuleSeverity() === 'error') { 
            category = ts.DiagnosticCategory.Error;
        } else {
            category = ts.DiagnosticCategory.Warning;
        }

        let diagnostic: ts.Diagnostic = {
            file: file,
            start: problem.getStartPosition().getPosition(),
            length: problem.getEndPosition().getPosition() - problem.getStartPosition().getPosition(),
            messageText: message,
            category: category,
            //TODO we "steal"" an error code with a registered code fix. 2515 = implement inherited abstract class
            code: 2515
        };
        return diagnostic;
    }

    /**
     * Filter failures for the given document
     */
    function filterProblemsForDocument(documentPath: string, failures: tslint.RuleFailure[]): tslint.RuleFailure[] {
        let normalizedPath = path.normalize(documentPath);
        // we only show diagnostics targetting this open document, some tslint rule return diagnostics for other documents/files
        let normalizedFiles = {};
        return failures.filter(each => {
            let fileName = each.getFileName();
            if (!normalizedFiles[fileName]) {
                normalizedFiles[fileName] = path.normalize(fileName);
            }
            return normalizedFiles[fileName] === normalizedPath;
        });
    }

/* TODO only required for custom code actions
    function registerCodeFix(action: codefix.CodeFix) {
      return ts.codefix.registerCodeFix(action);
    }

    if (!registeredCodeFixes && ts && ts.codefix) {        
        registerCodeFixes(registerCodeFix);
        registeredCodeFixes = true;
    }
*/

    function recordCodeAction(problem: tslint.RuleFailure, file: ts.SourceFile) {
        let fix: tslint.Fix = null;

        // tslint can return a fix with an empty replacements array, these fixes are ignored
        if (problem.getFix && problem.getFix() && problem.getFix().replacements && problem.getFix().replacements.length > 0) { // tslint fixes are not available in tslint < 3.17
            fix = problem.getFix(); // createAutoFix(problem, document, problem.getFix());
        }

        if (!fix) {
            return;
        }

        let documentAutoFixes: Map<tslint.Fix> = codeFixActions[file.fileName];
        if (!documentAutoFixes) {
            documentAutoFixes = Object.create(null);
            codeFixActions[file.fileName] = documentAutoFixes;
        }
        documentAutoFixes[computeKey(problem.getStartPosition().getPosition(), problem.getEndPosition().getPosition())] = fix;
    }

    proxy.getSemanticDiagnostics = (fileName: string) => {
        let prior = oldLS.getSemanticDiagnostics(fileName);
        if ( prior === undefined ) {
            prior = [];
        }

        try {
            info.project.projectService.logger.info( `Computing tslint semantic diagnostics...` );
            delete codeFixActions[fileName]; 
            
            try {
                configuration = getConfiguration(fileName, configFile);
            } catch (err) {
                // this should not happen since we guard against incorrect configurations
                // showConfigurationFailure(conn, err);
                return prior;
            }
            
            let result: tslint.LintResult;
            try { // protect against tslint crashes
                if (isTsLint4) {
                    // TODO the types of the Program provided by tsserver libary are not compatible with the one provided by typescript
                    // casting away the type
                    let options: tslint.ILinterOptions = {fix: false};
                    let tslint = new linter(options, <any>oldLS.getProgram());
                    tslint.lint(fileName, "", configuration);
                    result = tslint.getResult();
                }
                // support for linting js files is only available in tslint > 4.0
                /*else if (!isJsDocument(document)) {
                    (<any>options).configuration = configuration;
                    let tslint = new (<any>linter)(fsPath, contents, options);
                    result = tslint.lint();
                } else {
                    return diagnostics;
                }*/
            } catch (err) {
	            let errorMessage = `unknown error`;
                if (typeof err.message === 'string' || err.message instanceof String) {
                    errorMessage = <string>err.message;
                }
                info.project.projectService.logger.info('tslint error '+errorMessage);
                return prior;
            }
            
            if (result.failures.length > 0) {
                const tslintProblems = filterProblemsForDocument(fileName, result.failures);
                if ( tslintProblems && tslintProblems.length ) {
                  const file = oldLS.getProgram().getSourceFile( fileName );
                  prior.push.apply( prior, tslintProblems.map( d => makeDiagnostic( d, file ) ) );
                  tslintProblems.forEach(problem => {
                      recordCodeAction(problem, file);
                  });
              }
            }
        } catch (e) {
            info.project.projectService.logger.info( `tslint-language service error: ${e.toString()}` );
            info.project.projectService.logger.info( `Stack trace: ${e.stack}` );
        }
        return prior;
    };

    proxy.getCodeFixesAtPosition = function( fileName: string, start: number, end: number, errorCodes: number[] ): ts.CodeAction[] {
        let prior = oldLS.getCodeFixesAtPosition( fileName, start, end, errorCodes );
        if ( prior === undefined ) {
            prior = [];
        }
        info.project.projectService.logger.info("tslint-language-service getCodeFixes " + errorCodes[0] );
        let documentFixes = codeFixActions[fileName];

        if (documentFixes) {
            let fix = documentFixes[computeKey(start, end)];
            if (fix && fix.replacements) {
                // Add tslint replacements codefix
                const textChanges = fix.replacements.map(each => convertReplacementToTextChange(each));
                prior.push({
                    description: `Fix '${fix.ruleName}'`,
                    changes: [{
                        fileName: fileName,
                        textChanges: textChanges
                    }]
                });
                // Add disable tslint rule codefix
                // TODO
            }
        }
        return prior;
    };
    return proxy;
  }

  return { create };
}

export = init;

function getConfiguration(filePath: string, configFileName: string): any {
    if (configCache.configuration && configCache.filePath === filePath) {
        return configCache.configuration;
    }

    let isDefaultConfig = false;
    let configuration;
    let configFilePath = null;
    if (isTsLint4) {
        if (linterConfiguration.findConfigurationPath) {
            isDefaultConfig = linterConfiguration.findConfigurationPath(configFileName, filePath) === undefined;
        }
        let configurationResult = linterConfiguration.findConfiguration(configFileName, filePath);

        // between tslint 4.0.1 and tslint 4.0.2 the attribute 'error' has been removed from IConfigurationLoadResult
        // in 4.0.2 findConfiguration throws an exception as in version ^3.0.0
        if ((<any>configurationResult).error) {
            throw (<any>configurationResult).error;
        }
        configuration = configurationResult.results;
        configFilePath = configurationResult.path;
    } else {
        // prior to tslint 4.0 the findconfiguration functions where attached to the linter function
        if (linter.findConfigurationPath) {
            isDefaultConfig = linter.findConfigurationPath(configFileName, filePath) === undefined;
        }
        configuration = linter.findConfiguration(configFileName, filePath);
        configFilePath = configuration.path;
    }

    configCache = {
        filePath: filePath,
        isDefaultConfig: isDefaultConfig,
        configuration: configuration,
        configFilePath : configFilePath
    };
    return configCache.configuration;
}

function convertReplacementToTextChange(repl: tslint.Replacement): ts.TextChange {
    return {
        newText: repl.text,
        span: {start: repl.start, length: repl.length}
    };
}
