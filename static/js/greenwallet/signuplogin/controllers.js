angular.module('greenWalletSignupLoginControllers', ['greenWalletMnemonicsServices'])
.controller('SignupLoginController', ['$scope', '$modal', 'focus', 'wallets', 'notices', 'mnemonics', '$location', 'cordovaReady', 'facebook', 'tx_sender', 'crypto', 'gaEvent', 'reddit', 'storage',
        function SignupLoginController($scope, $modal, focus, wallets, notices, mnemonics, $location, cordovaReady, facebook, tx_sender, crypto, gaEvent, reddit, storage) {
    var state = {};
    storage.get(['pin_ident', 'encrypted_seed', 'pin_refused']).then(function(data) {
        state.has_pin = data.pin_ident && data.encrypted_seed;
        state.refused_pin = data.pin_refused || storage.noLocalStorage;  // don't show the PIN popup if no storage is available
        state.pin_ident = data.pin_ident;
        state.encrypted_seed = data.encrypted_seed;
    });
    if ($scope.wallet) {
        $scope.wallet.signup = false;  // clear signup state
    }
    $scope.state = state;
    var modal;

    $scope.login = function() {
        if (use_pin_data.pin) { gaEvent('Login', 'PinLogin'); $scope.use_pin(); return; }
        gaEvent('Login', 'MnemonicLogin');
        state.mnemonic_error = state.login_error = undefined;
        mnemonics.validateMnemonic(state.mnemonic).then(function() {
            mnemonics.toSeed(state.mnemonic).then(function(seed) {
                var hdwallet = new GAHDWallet({seed_hex: seed});
                state.seed_progress = 100;
                state.seed = seed;
                var do_login = function() {
                    return wallets.login($scope, hdwallet, state.mnemonic).then(function(data) {
                        if (!data) {
                            gaEvent('Login', 'MnemonicLoginFailed');
                            state.login_error = true;
                        } else {
                            gaEvent('Login', 'MnemonicLoginSucceeded');
                        }
                    });
                };
                if (!state.has_pin && !state.refused_pin) {
                    gaEvent('Login', 'MnemonicLoginPinModalShown');
                    modal = $modal.open({
                        templateUrl: '/'+LANG+'/wallet/partials/wallet_modal_pin.html',
                        scope: $scope
                    });
                    modal.opened.then(function() { focus("pinModal"); });
                    return modal.result.then(do_login, function() {
                        storage.set('pin_refused', true);
                        return do_login();
                    })
                } else {
                    return do_login();
                }
            }, undefined, function(progress) {
                state.seed_progress = progress;
            }).catch(function() {
                state.seed_progress = undefined;
            });
        }, function(e) {
            gaEvent('Login', 'MnemonicError', e);
            state.mnemonic_error = e;
        });
    };
    
    if ($location.hash()) {
        try {
            var nfc_bytes = Crypto.util.base64ToBytes($location.hash());
        } catch(e) {}
        if (nfc_bytes) {
            gaEvent('Login', 'NfcLogin');
            mnemonics.toMnemonic(nfc_bytes).then(function(mnemonic) {
                state.mnemonic = mnemonic;
                $scope.login();
            });
        } else if (state.has_pin) {
            focus('pin');
        }
    } else if (state.has_pin) {
        focus('pin');
    }

    $scope.set_pin = function set_pin(valid) {
        if (!valid) {
            $scope.state.error = true;
        } else {
            wallets.create_pin(state.new_pin_value, state.seed, state.mnemonic, $scope).then(function() {
                gaEvent('Login', 'PinSet');
                modal.close();
            }, function(error) {
                gaEvent('Login', 'PinSettingError', error.desc);
                notices.makeNotice('error', error.desc);
            });
        }
    };

    state.fbloginstate = {};
    $scope.login_with_facebook = function() {
        gaEvent('Login', 'FacebookLogin');
        facebook.login(state.fbloginstate).then(function(succeeded) {
            wallets.loginWatchOnly($scope, 'facebook', FB.getAuthResponse().accessToken).then(function() {
                gaEvent('Login', 'FacebookLoginSucceeded');
            }).catch(function(e) {
                if (e.uri == "http://greenaddressit.com/error#usernotfound") {
                    gaEvent('Login', 'FacebookLoginRedirectedToOnboarding');
                    $scope.wallet.signup_fb_prelogged_in = true;
                    $location.path('/create');
                } else {
                    gaEvent('Login', 'FacebookLoginFailed', e.desc);
                    notices.makeNotice('error', e.desc);
                }
            });
        });
    };

    $scope.login_with_reddit = function() {
        gaEvent('Login', 'RedditLogin');
        reddit.getToken('identity').then(function(token) {
            if (!token) return;
            wallets.loginWatchOnly($scope, 'reddit', token).then(function() {
                gaEvent('Login', 'RedditLoginSucceeded');
            }).catch(function(e) {
                if (e.uri == "http://greenaddressit.com/error#usernotfound") {
                    gaEvent('Login', 'RedditLoginRedirectedToOnboarding');
                    $scope.wallet.signup_reddit_prelogged_in = token;
                    $location.path('/create');
                } else {
                    gaEvent('Login', 'RedditLoginFailed', e.desc);
                    notices.makeNotice('error', e.desc);
                }
            });
        });
    };
    
    $scope.read_qr_code = function read_qr_code() {
        gaEvent('Login', 'QrScanClicked');
        cordovaReady(function()  {
            cordova.plugins.barcodeScanner.scan(
                function (result) {
                    console.log("We got a barcode\n" +
                    "Result: " + result.text + "\n" +
                    "Format: " + result.format + "\n" +
                    "Cancelled: " + result.cancelled);
                    if (!result.cancelled && result.format == "QR_CODE") {
                          gaEvent('Login', 'QrScanningSucceeded');
                          state.mnemonic = result.text;
                          $scope.login();
                    }
                }, 
                function (error) {
                    gaEvent('Login', 'QrScanningFailed', error);
                    console.log("Scanning failed: " + error);
                }
            );
        })();
    };

    var use_pin_data = $scope.use_pin_data = {};

    $scope.use_pin = function(valid) {
        notices.setLoadingText("Checking PIN");
        tx_sender.call('http://greenaddressit.com/pin/get_password', use_pin_data.pin, state.pin_ident).then(
            function(password) {
                if (!password) {
                    gaEvent('Login', 'PinLoginFailed', 'empty password');
                    return;
                }
                tx_sender.pin_ident = state.pin_ident;
                tx_sender.pin = use_pin_data.pin;
                var decoded = crypto.decrypt(state.encrypted_seed, password);
                if(decoded && JSON.parse(decoded).seed) {
                    gaEvent('Login', 'PinLoginSucceeded');
                    var parsed = JSON.parse(decoded);
                    var hdwallet = new GAHDWallet({seed_hex: parsed.seed});
                    wallets.login($scope, hdwallet, parsed.mnemonic);
                } else {
                    gaEvent('Login', 'PinLoginFailed', 'Wallet decryption failed');
                    notices.makeNotice('error', gettext('Wallet decryption failed'));
                }
            }, function(e) {
                gaEvent('Login', 'PinLoginFailed', e.desc);
                notices.makeNotice('error', e.desc);
            });
    }
}]);
